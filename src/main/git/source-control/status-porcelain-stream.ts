import { StatusPorcelainParser } from '../../../shared/git/status/git-status-porcelain-parser'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'

/** Failed reads keep the rows parsed before Git failed; `error` carries the failure, including aborts. */
export type StatusPorcelainRead = {
  parser: StatusPorcelainParser
  stoppedEarly: boolean
  error?: unknown
}

/** Stream porcelain v2 status; never rejects so callers can await other probes first. */
export async function readStatusPorcelain(
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  // Keep non-ASCII paths readable instead of Git's octal escapes.
  const args = [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all'
  ]
  if (options.includeIgnored) {
    args.push('--ignored=matching')
  }
  return streamStatusPorcelain(args, worktreePath, options, limit)
}

async function streamStatusPorcelain(
  args: string[],
  worktreePath: string,
  options: GetStatusOptions,
  limit: number
): Promise<StatusPorcelainRead> {
  // Bound streaming status so huge unignored folders cannot exhaust process memory.
  const parser = new StatusPorcelainParser()
  try {
    const result = await gitStreamStdout(args, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      admissionTier: options.admissionTier,
      preferWslDirectGit: true,
      // Read-only polls must not compete with terminal Git for index.lock.
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, limit)
    })
    if (!result.stoppedEarly) {
      parser.finish()
    }
    return { parser, stoppedEarly: result.stoppedEarly }
  } catch (error) {
    return { parser, stoppedEarly: false, error }
  }
}
