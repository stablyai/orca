import { stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { isMissingCommandBinaryError } from '../exec-error'

const MAX_KNOWN_MISSING_CWDS = 256
// Remember missing folders in memory to avoid a failing Git spawn on every sweep.
const knownMissingCwds = new Set<string>()

type GitCwdOptions = { cwd?: string; wslDistro?: string; signal?: AbortSignal }

// Cache native absence only; unreachable WSL/UNC paths do not prove deletion.
function recordableCwd({ cwd, wslDistro }: GitCwdOptions): string | null {
  const routesThroughWsl = process.platform === 'win32' && Boolean(wslDistro)
  return cwd && !routesThroughWsl && !/^[\\/]{2}/.test(cwd) ? cwd : null
}

// Match spawn chdir semantics: stat follows symlinked roots.
function isCwdAbsent(cwd: string): Promise<boolean> {
  return stat(cwd).then(() => false, isDefinitiveAbsence)
}

async function noteMissingCwd(error: unknown, cwd: string, signal?: AbortSignal): Promise<void> {
  if (!isMissingCommandBinaryError(error) || signal?.aborted || knownMissingCwds.has(cwd)) {
    return
  }
  // Recheck after stat so concurrent failures record and warn once.
  if (!(await isCwdAbsent(cwd)) || knownMissingCwds.has(cwd)) {
    return
  }
  knownMissingCwds.add(cwd)
  if (knownMissingCwds.size > MAX_KNOWN_MISSING_CWDS) {
    knownMissingCwds.delete(knownMissingCwds.values().next().value ?? cwd)
  }
  console.warn('[git] repository folder missing; skipping Git there until it returns:', cwd)
}

/** Answers a known-missing native cwd without starting Git; healthy repos pay one Set lookup. */
export function runUnlessGitCwdKnownMissing<T>(
  options: GitCwdOptions,
  run: () => Promise<T>
): Promise<T> {
  const cwd = recordableCwd(options)
  if (!cwd) {
    return run()
  }
  const runAndNote = (): Promise<T> =>
    run().catch(async (error: unknown) => {
      await noteMissingCwd(error, cwd, options.signal)
      throw error
    })
  if (!knownMissingCwds.has(cwd)) {
    return runAndNote()
  }
  return waitForPromiseWithSignal(isCwdAbsent(cwd), options.signal).then((absent) => {
    if (!absent) {
      knownMissingCwds.delete(cwd)
      return runAndNote()
    }
    // Preserve the spawn failure shape expected by existing callers.
    throw Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn git',
      path: 'git',
      stdout: '',
      stderr: ''
    })
  })
}
