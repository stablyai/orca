import { createPtySlaveLineEditorProbe } from '../shared/pty-slave-line-discipline-echo'
import {
  listChildProcessIds,
  readShellProcessReadiness,
  resolveInstalledShellExecutablePaths,
  resolveShellExecutablePath
} from '../shared/shell-process-readiness'
import {
  createLineEditorReadyOutputScanState,
  scanForLineEditorReadyOutput
} from './line-editor-ready-output-scanner'
import { basename } from 'node:path'

export const SHELL_PROMPT_PROBE_SETTLE_MS = 50
export const MAX_SHELL_PROMPT_PROBES = 4

export type ShellPromptReadinessProbe = {
  notifyOutput(data: string): void
  dispose(): void
}

export function createShellPromptReadinessProbe(options: {
  slavePath: string | undefined
  getShellPid: () => number | null
  shellPath: string | undefined
  shellCwd?: string
  shellPathEnv?: string
  onPromptReady: () => void
  settleMs?: number
}): ShellPromptReadinessProbe | null {
  const lineEditorProbe = createPtySlaveLineEditorProbe(options.slavePath)
  if (!lineEditorProbe) {
    return null
  }
  const settleMs = options.settleMs ?? SHELL_PROMPT_PROBE_SETTLE_MS
  const expectedShellName = options.shellPath ? basename(options.shellPath).toLowerCase() : null
  const shellCwd = options.shellCwd ?? process.cwd()
  const outputScanState = createLineEditorReadyOutputScanState()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let probesStarted = 0

  const isStale = (scheduledGeneration: number): boolean =>
    disposed || scheduledGeneration !== generation

  const isExpectedShell = async (executablePath: string): Promise<boolean> => {
    if (!expectedShellName || basename(executablePath).toLowerCase() !== expectedShellName) {
      return false
    }
    const expectedPath = options.shellPath
      ? await resolveShellExecutablePath(options.shellPath, shellCwd, options.shellPathEnv)
      : null
    if (!expectedPath) {
      return false
    }
    if (executablePath === expectedPath) {
      return true
    }
    // Profiles can exec another installed shell; accept only replacements found on this pane's PATH.
    const installedPaths = await resolveInstalledShellExecutablePaths(
      expectedShellName,
      shellCwd,
      options.shellPathEnv
    )
    return installedPaths.includes(executablePath)
  }

  // A pty relay exec'd over the shell (kiro-cli-term, #25586) runs it as a child on an inner pty.
  const isRelayedShellAtPrompt = async (
    relayPid: number,
    scheduledGeneration: number
  ): Promise<boolean> => {
    for (const childPid of await listChildProcessIds(relayPid)) {
      const child = await readShellProcessReadiness(childPid).catch(() => null)
      if (isStale(scheduledGeneration)) {
        return false
      }
      if (
        !child?.foreground ||
        !child.ttyPath ||
        child.ttyPath === options.slavePath ||
        !(await isExpectedShell(child.executablePath))
      ) {
        continue
      }
      if ((await createPtySlaveLineEditorProbe(child.ttyPath)?.()) === 'line-editor') {
        return true
      }
    }
    return false
  }

  const probe = async (scheduledGeneration: number): Promise<void> => {
    if (isStale(scheduledGeneration)) {
      return
    }
    const shellPid = options.getShellPid()
    if (!shellPid) {
      return
    }
    const outerState = await lineEditorProbe()
    if (isStale(scheduledGeneration)) {
      return
    }
    const shell = await readShellProcessReadiness(shellPid)
    if (isStale(scheduledGeneration) || !shell?.foreground) {
      return
    }
    const ready = (await isExpectedShell(shell.executablePath))
      ? outerState === 'line-editor'
      : await isRelayedShellAtPrompt(shellPid, scheduledGeneration)
    if (!ready || isStale(scheduledGeneration)) {
      return
    }
    disposed = true
    options.onPromptReady()
  }

  return {
    notifyOutput(data: string): void {
      if (
        disposed ||
        probesStarted >= MAX_SHELL_PROMPT_PROBES ||
        !scanForLineEditorReadyOutput(outputScanState, data)
      ) {
        return
      }
      generation += 1
      const scheduledGeneration = generation
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        probesStarted += 1
        void probe(scheduledGeneration).catch(() => {})
      }, settleMs)
    },
    dispose(): void {
      disposed = true
      generation += 1
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
