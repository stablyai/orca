import { stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { isMissingCommandBinaryError } from '../exec-error'

const MAX_KNOWN_MISSING_CWDS = 256
// Why: in memory only; a deleted project folder otherwise spawns a failing Git on every sweep.
const knownMissingCwds = new Set<string>()

type GitCwdOptions = { cwd?: string; wslDistro?: string; signal?: AbortSignal }

// Why: only native routes; WSL and UNC absence is not a cheap local answer, and loss of contact is not proof.
function recordableCwd({ cwd, wslDistro }: GitCwdOptions): string | null {
  const routesThroughWsl = process.platform === 'win32' && Boolean(wslDistro)
  return cwd && !routesThroughWsl && !/^[\\/]{2}/.test(cwd) ? cwd : null
}

// Why stat: spawn's chdir follows symlinks, so a symlinked root whose target is gone is absent too.
function isCwdAbsent(cwd: string): Promise<boolean> {
  return stat(cwd).then(() => false, isDefinitiveAbsence)
}

async function noteMissingCwd(error: unknown, cwd: string, signal?: AbortSignal): Promise<void> {
  if (!isMissingCommandBinaryError(error) || signal?.aborted || knownMissingCwds.has(cwd)) {
    return
  }
  // Why re-check: concurrent first failures for one folder must record and warn once.
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
    // Why: same shape as the real spawn failure, so every caller keeps its existing result.
    throw Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn git',
      path: 'git',
      stdout: '',
      stderr: ''
    })
  })
}
