import * as hostListLoads from './host-list-load-sharing'
import { readStoredHostProfilesForMutation, writeStoredHostProfiles } from './host-metadata-store'
import type { StoredHostProfile } from './types'

// Why: serialize host metadata RMW so concurrent writers cannot drop updates.
let hostListMutation: Promise<void> = Promise.resolve()

// Why: writers hold the chain across their full RMW; readers wait so a load doesn't race a half-written list.
export function waitForHostListMutations(): Promise<void> {
  return hostListMutation
}

export function enqueueHostListMutation(operation: () => Promise<void>): Promise<void> {
  const mutation = hostListMutation.then(operation)
  hostListMutation = mutation.catch(() => {})
  return mutation
}

export function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[] | Promise<StoredHostProfile[]>
): Promise<void> {
  return enqueueHostListMutation(async () => {
    const current = await readStoredHostProfilesForMutation()
    await writeStoredHostProfiles(await update(current))
    hostListLoads.dropSharedHostListLoad()
  })
}

/** Test-only: drain the module mutation chain between cases. */
export function resetHostListMutationQueueForTests(): void {
  hostListMutation = Promise.resolve()
}
