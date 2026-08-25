import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { createAbortError } from './abort-error'
import { resolveGitCommand } from './git-command-resolution'
import { untranslatedGitOutputEnv } from './git-process-env'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export type GitSpawnOptions = SpawnOptions & { cwd: string; wslDistro?: string }

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
  return gitSpawn(args, env === options.env ? options : { ...options, env })
}

export function gitSpawn(args: string[], options: GitSpawnOptions): ChildProcess {
  const { wslDistro, ...spawnOptions } = options
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
