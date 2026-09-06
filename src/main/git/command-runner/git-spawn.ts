import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { startGitSpan } from '../../observability/instrumentation'
import { createAbortError } from './abort-error'
import { resolveGitCommand } from './git-command-resolution'
import { untranslatedGitOutputEnv } from './git-process-env'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import type { GitAdmissionTier } from './git-exec-options'
import { acquireGitAdmission } from './git-subprocess-admission'

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export type GitSpawnOptions = SpawnOptions & {
  cwd: string
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export async function gitSpawnAfterWindowsEnvironmentReady(
  args: string[],
  options: GitSpawnOptions
): Promise<ChildProcess> {
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  const env = await (prepareWindowsHostGitEnvironment(resolved, options.env, options.signal) ??
    options.env)
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  return withGitAdmission(args, env === options.env ? options : { ...options, env })
}

export async function withGitAdmission(
  args: string[],
  options: GitSpawnOptions,
  spawnChild: () => ChildProcess = () => gitSpawn(args, options)
): Promise<ChildProcess> {
  const span = startGitSpan({ args, cwd: options.cwd })
  let grant: Awaited<ReturnType<typeof acquireGitAdmission>> | null = null
  try {
    grant = await acquireGitAdmission({
      args,
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.admissionTier,
      signal: options.signal
    })
    span.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
    if (options.signal?.aborted) {
      grant.release()
      span.fail(createAbortError())
      throw createAbortError()
    }
    const child = spawnChild()
    let finalized = false
    let liveError: Error | null = null
    const finalize = (error?: Error): void => {
      if (finalized) {
        return
      }
      finalized = true
      child.off('error', handleError)
      child.off('close', handleClose)
      grant?.release()
      if (error) {
        span.fail(error)
      } else {
        span.end()
      }
    }
    const handleError = (error: Error): void => {
      if (!child.pid) {
        finalize(error)
      } else {
        liveError = error
      }
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      const exitError =
        liveError ??
        (code === 0 && signal === null
          ? undefined
          : new Error(`git exited with ${code ?? signal ?? 'unknown'}.`))
      finalize(exitError)
    }
    child.on('error', handleError)
    child.once('close', handleClose)
    return child
  } catch (error) {
    grant?.release()
    span.fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

export function gitSpawn(args: string[], options: GitSpawnOptions): ChildProcess {
  const { wslDistro, admissionTier: _admissionTier, ...spawnOptions } = options
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    ...(wslDistro ? { wslDistro } : {}),
    ...(spawnOptions.env ? { env: spawnOptions.env } : {})
  })
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env),
    windowsHide: true,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}
