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
    const [shell, expectedPath] = await Promise.all([
      readShellProcessReadiness(shellPid),
      options.shellPath
        ? resolveShellExecutablePath(options.shellPath, shellCwd, options.shellPathEnv)
        : Promise.resolve(null)
    ])
    if (disposed || scheduledGeneration !== generation) {
      return
    }
    if (
      !shell?.foreground ||
      !expectedShellName ||
      !expectedPath ||
      basename(shell.executablePath).toLowerCase() !== expectedShellName
    ) {
      return
    }
    if (shell.executablePath !== expectedPath) {
      // Why widen past the launched path: a startup profile that `exec`s a second
      // install of the same shell (Homebrew Bash over /bin/bash) keeps the pid but
      // loses the wrapper's marker. Only installs this pane's own PATH resolves
      // count, so a binary merely *named* bash/zsh outside it stays rejected.
      const installedPaths = await resolveInstalledShellExecutablePaths(
        expectedShellName,
        shellCwd,
        options.shellPathEnv
      )
      if (
        disposed ||
        scheduledGeneration !== generation ||
        !installedPaths.includes(shell.executablePath)
      ) {
        return
      }
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
