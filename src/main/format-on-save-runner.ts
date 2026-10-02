import {
  expandFormatOnSaveCommand,
  isFormatOnSaveConfigured,
  matchesFormatOnSaveInclude,
  type FormatOnSaveResult
} from '../shared/format-on-save-command'
import { executeFormatCommand, type FormatCommandExecution } from './format-on-save-process'
import { FORMAT_ON_SAVE_TIMEOUT_MS } from './format-on-save-timeout'

export { FORMAT_ON_SAVE_TIMEOUT_MS }
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../shared/cross-platform-path'
import { resolveFormatTarget } from './format-on-save-file-containment'
import { stableInFlightKey } from '../shared/in-flight-promise-dedupe'
import type { RepoFormatOnSaveSettings } from '../shared/repo-types'

export type RemoteFormatExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  spawnError?: string
}

/**
 * Runs the formatter on the host that owns the file. Injected rather than
 * imported so the runner keeps no SSH provider dependency.
 */
export type RemoteFormatExecutor = (request: {
  binary: string
  args: string[]
  cwd: string
  timeoutMs: number
}) => Promise<RemoteFormatExecResult>

export type FormatOnSaveRequest = {
  settings: RepoFormatOnSaveSettings | undefined | null
  worktreePath: string
  absoluteFilePath: string
  /** Present for SSH-backed repos; absent means the file lives on this machine. */
  remoteExec?: RemoteFormatExecutor
  /** Scopes the in-flight slot so an identical path on two hosts doesn't collide. */
  hostScope?: string
}

// Why: autosave fires on a short debounce and a formatter rewrites the file it
// is reading; overlapping runs on one path race each other's output.
const inFlightPaths = new Set<string>()

export async function runFormatOnSave({
  settings,
  worktreePath,
  absoluteFilePath: requestedFilePath,
  remoteExec,
  hostScope
}: FormatOnSaveRequest): Promise<FormatOnSaveResult> {
  if (!isFormatOnSaveConfigured(settings) || !settings) {
    return { status: 'skipped', reason: 'not-configured' }
  }

  const target = await resolveFormatTarget({
    worktreePath,
    absoluteFilePath: requestedFilePath,
    isRemote: remoteExec !== undefined
  })
  if (target === null) {
    // Why: the command runs with the worktree as cwd, so a file outside it has no meaningful ${relativeFile}.
    return { status: 'skipped', reason: 'outside-worktree' }
  }
  const { absolutePath: absoluteFilePath, relativePath } = target

  if (!matchesFormatOnSaveInclude(relativePath, settings.include)) {
    return { status: 'skipped', reason: 'not-included' }
  }

  // Why: use the comparison form so Windows' case-insensitive paths share one
  // in-flight slot. POSIX paths are left case-sensitive on purpose — folding them
  // would treat two genuinely different files as one.
  const inFlightKey = stableInFlightKey([
    hostScope ?? 'local',
    normalizeRuntimePathForComparison(absoluteFilePath)
  ])
  if (inFlightPaths.has(inFlightKey)) {
    return { status: 'skipped', reason: 'already-running' }
  }

  inFlightPaths.add(inFlightKey)
  try {
    if (remoteExec) {
      return await executeRemoteFormatCommand({
        command: settings.command,
        worktreePath,
        absoluteFilePath,
        relativePath,
        remoteExec
      })
    }
    return await executeFormatCommand({
      command: settings.command,
      worktreePath,
      absoluteFilePath,
      relativePath
    })
  } finally {
    inFlightPaths.delete(inFlightKey)
  }
}

type RemoteFormatCommandExecution = FormatCommandExecution & {
  remoteExec: RemoteFormatExecutor
}

async function executeRemoteFormatCommand({
  command,
  worktreePath,
  absoluteFilePath,
  relativePath,
  remoteExec
}: RemoteFormatCommandExecution): Promise<FormatOnSaveResult> {
  // Why: the remote host's shell decides the quoting, not this machine's. A
  // Windows SSH host is detected the same way the worktree hooks detect it —
  // from the shape of the remote path.
  const isWindowsRemote = isWindowsAbsolutePathLike(worktreePath)
  let expanded: string
  try {
    expanded = expandFormatOnSaveCommand({
      command,
      absolutePath: absoluteFilePath,
      relativePath,
      platform: isWindowsRemote ? 'win32' : 'linux'
    })
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }

  let result: RemoteFormatExecResult
  try {
    result = await remoteExec({
      binary: isWindowsRemote ? 'cmd.exe' : '/bin/bash',
      args: isWindowsRemote ? ['/d', '/s', '/c', expanded] : ['-lc', expanded],
      cwd: worktreePath,
      timeoutMs: FORMAT_ON_SAVE_TIMEOUT_MS
    })
  } catch (error) {
    // Why: a dropped relay must not be reported as the formatter rejecting the
    // file — the save already succeeded, so this is a skip, not a failure.
    console.warn('[format-on-save] remote exec unavailable', error)
    return { status: 'skipped', reason: 'unsupported-host' }
  }

  if (result.spawnError) {
    return { status: 'failed', message: result.spawnError }
  }
  if (result.timedOut) {
    return {
      status: 'failed',
      message: `Formatter timed out after ${FORMAT_ON_SAVE_TIMEOUT_MS}ms.`
    }
  }
  if (result.exitCode === 0) {
    return { status: 'completed' }
  }

  const message = [result.stderr?.trim(), result.stdout?.trim()].find(
    (candidate) => candidate && candidate.length > 0
  )
  return { status: 'failed', message: message ?? 'Formatter failed.' }
}

export function _resetFormatOnSaveInFlightForTests(): void {
  inFlightPaths.clear()
}
