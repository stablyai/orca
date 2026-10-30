import * as hostListLoads from './host-list-load-sharing'
import { readStoredHostProfilesForMutation, writeStoredHostProfiles } from './host-metadata-store'
import type { StoredHostProfile } from './types'

// Why: serialize host metadata RMW so concurrent writers cannot drop updates.
let hostListMutation: Promise<void> = Promise.resolve()

/** Settles once every mutation queued so far has, so a reader never sees a half-written list. */
export function hostListMutationsSettled(): Promise<void> {
  return hostListMutation
}

export function enqueueHostListMutation<T>(operation: () => Promise<T>): Promise<T> {
  const mutation = hostListMutation.then(operation)
  hostListMutation = mutation.then(
    () => {},
    () => {}
  )
  return mutation
}

export async function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[] | Promise<StoredHostProfile[]>,
  observer?: (
    value:
      | { status: 'committed'; revision: number; profiles: readonly StoredHostProfile[] }
      | { status: 'unavailable' }
  ) => void
): Promise<void> {
  const notify: NonNullable<typeof observer> = (value) => {
    try {
      observer?.(value)
    } catch {
      /* Bookkeeping cannot fail a committed host action. */
    }
  }
  return enqueueHostListMutation(async () => {
    const current = await readStoredHostProfilesForMutation()
    const next = await update(current)
    // Identity-preserving updates must not rewrite storage or invalidate shared loads on each descriptor read.
    if (next === current) {
      return
    }
    await writeStoredHostProfiles(next)
    hostListLoads.dropSharedHostListLoad()
    notify({
      status: 'committed',
      revision: hostListLoads.getHostListLoadRevision(),
      profiles: next
    })
  }).catch((error) => {
    notify({ status: 'unavailable' })
    throw error
  })
}

export function resetHostListMutationQueueForTests(): void {
  hostListMutation = Promise.resolve()
}
