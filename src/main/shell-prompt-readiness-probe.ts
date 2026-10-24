import { createPtySlaveLineEditorProbe } from '../shared/pty-slave-line-discipline-echo'
import {
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
  onPromptReady: (executablePath: string) => void
  settleMs?: number
}): ShellPromptReadinessProbe | null {
  const lineEditorProbe = createPtySlaveLineEditorProbe(options.slavePath)
  if (!lineEditorProbe) {
    return null
  }
  const settleMs = options.settleMs ?? SHELL_PROMPT_PROBE_SETTLE_MS
  const shellCwd = options.shellCwd ?? process.cwd()
  const outputScanState = createLineEditorReadyOutputScanState()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let probesStarted = 0

  const probe = async (scheduledGeneration: number): Promise<void> => {
    if (disposed || scheduledGeneration !== generation) {
      return
    }
    const shellPid = options.getShellPid()
    if (!shellPid || (await lineEditorProbe()) !== 'line-editor') {
      return
    }
    if (disposed || scheduledGeneration !== generation) {
      return
    }
    const executablePath = await readMatchingPromptShellExecutable({
      shellPid,
      shellPath: options.shellPath,
      shellCwd,
      shellPathEnv: options.shellPathEnv
    })
    if (disposed || scheduledGeneration !== generation || !executablePath) {
      return
    }
    disposed = true
    options.onPromptReady(executablePath)
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

export async function readMatchingPromptShellExecutable(options: {
  shellPid: number
  shellPath: string | undefined
  shellCwd: string
  shellPathEnv?: string
}): Promise<string | null> {
  const expectedShellName = options.shellPath ? basename(options.shellPath).toLowerCase() : null
  const [shell, expectedPath] = await Promise.all([
    readShellProcessReadiness(options.shellPid),
    options.shellPath
      ? resolveShellExecutablePath(options.shellPath, options.shellCwd, options.shellPathEnv)
      : Promise.resolve(null)
  ])
  if (
    !shell?.foreground ||
    !expectedShellName ||
    !expectedPath ||
    basename(shell.executablePath).toLowerCase() !== expectedShellName
  ) {
    return null
  }
  if (shell.executablePath !== expectedPath) {
    // Why: profile exec may replace the binary with another installed copy of the same shell.
    const installedPaths = await resolveInstalledShellExecutablePaths(
      expectedShellName,
      options.shellCwd,
      options.shellPathEnv
    )
    if (!installedPaths.includes(shell.executablePath)) {
      return null
    }
  }
  return shell.executablePath
}
