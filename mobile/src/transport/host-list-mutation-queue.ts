import * as hostListLoads from './host-list-load-sharing'
import { readStoredHostProfilesForMutation, writeStoredHostProfiles } from './host-metadata-store'
import type { StoredHostProfile } from './types'

// Why: serialize host metadata RMW so concurrent writers cannot drop updates.
let hostListMutation: Promise<void> = Promise.resolve()

/** Settles once every mutation queued so far has, so a reader never sees a half-written list. */
export function hostListMutationsSettled(): Promise<void> {
  return hostListMutation
}

export function enqueueHostListMutation(operation: () => Promise<void>): Promise<void> {
  const mutation = hostListMutation.then(operation)
  hostListMutation = mutation.catch(() => {})
  return mutation
}

export async function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[] | Promise<StoredHostProfile[]>
): Promise<void> {
  return enqueueHostListMutation(async () => {
    const current = await readStoredHostProfilesForMutation()
    const next = await update(current)
    // Why: an update handing back the list it read changed nothing; a per-connect descriptor
    // read must not rewrite storage and invalidate every shared host-list load.
    if (next === current) {
      return
    }
    await writeStoredHostProfiles(next)
    hostListLoads.dropSharedHostListLoad()
  })
}

/** Test-only: drain the mutation chain between cases. */
export function resetHostListMutationQueueForTests(): void {
  hostListMutation = Promise.resolve()
}
