import * as hostListLoads from './host-list-load-sharing'
import { hostListMutationsSettled } from './host-list-mutation-queue'
import {
  hasPendingPairingPublications,
  pairingPublicationsSettled
} from './pairing-publication-fence'

// A write that completes mid-read (a pairing save lands metadata, token and relay routing in turn) makes the snapshot stale.
const MAX_STALE_HOST_LOAD_RETRIES = 4

export async function loadSettledHostListSnapshot(
  load: () => Promise<hostListLoads.HostListSnapshot>
): Promise<hostListLoads.HostListSnapshot> {
  for (let retries = 0; ; retries++) {
    // Wait for full serialized mutations so loads cannot read half-written state.
    await pairingPublicationsSettled()
    await hostListMutationsSettled()
    // A save can register while the mutation wait runs; check it in the same step that captures the revision.
    if (hasPendingPairingPublications() && retries < MAX_STALE_HOST_LOAD_RETRIES) {
      continue
    }
    const startedRevision = hostListLoads.getHostListLoadRevision()
    const snapshot = await hostListLoads.shareHostListLoad(load)
    const stale = startedRevision !== hostListLoads.getHostListLoadRevision()
    if (!stale || retries >= MAX_STALE_HOST_LOAD_RETRIES) {
      return snapshot
    }
  }
}
