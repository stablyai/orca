import { wslDistroStoppedMessage } from '../../shared/wsl-distro-not-running-refusal'
import type { ReviewStartPointFailure } from '../../shared/review-start-point-failure-copy'
import {
  guardWslUncPathAccess,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../wsl/wsl-unc-access-gate'

/**
 * Resolves a PR start point unless its repo's WSL distro is stopped (E9): a background push-target
 * ensure gets a start-point failure instead of starting it. `wakeWslDistro` marks the user creating
 * or launching from the PR, which may start it.
 */
export async function resolvePrStartPointUnlessWslStopped<T>(
  repo: { path: string; wslDistro?: string },
  options: { wakeWslDistro?: boolean },
  resolve: () => Promise<T>
): Promise<T | ReviewStartPointFailure> {
  try {
    return await guardWslUncPathAccess(repo.path, resolve, {
      wake: options.wakeWslDistro === true,
      wslDistro: repo.wslDistro
    })
  } catch (error) {
    if (error instanceof WslDistroStoppedError) {
      // Uncoded: the English text is the refusal contract, and the push-target ensure only logs it.
      return { error: wslDistroStoppedMessage(error.distro, false) }
    }
    if (error instanceof WslDistroUnverifiableError) {
      return { error: error.message }
    }
    throw error
  }
}
