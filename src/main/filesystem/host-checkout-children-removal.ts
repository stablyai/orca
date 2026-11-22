import { join } from 'node:path'
import { mapSettledWithConcurrency } from '../../shared/concurrency/map-with-concurrency'
import { rm } from './asar-transparent-fs'

/** Delete a checkout's children; the caller keeps `.git` out of `names` so it goes last. */
export async function deleteHostChildren(
  root: string,
  names: readonly string[],
  guard?: (markerGone: boolean) => Promise<void>
): Promise<void> {
  // A guarded delete re-checks identity before each child, so it bounds how many start together.
  let guardFailure: unknown
  const removeChild = async (name: string) => {
    if (guardFailure) {
      throw guardFailure
    }
    if (guard) {
      try {
        await guard(false)
        if (guardFailure) {
          throw guardFailure
        }
      } catch (error) {
        guardFailure = error
        throw error
      }
    }
    return rm(join(root, name), { recursive: true, force: true })
  }
  const results = guard
    ? await mapSettledWithConcurrency(names, 4, removeChild)
    : await Promise.allSettled(names.map(removeChild))
  const failures = results.filter((result) => result.status === 'rejected')
  const failure =
    failures.find(({ reason }) => !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(reason?.code)) ??
    failures[0]
  if (failure) {
    throw failure.reason
  }
}
