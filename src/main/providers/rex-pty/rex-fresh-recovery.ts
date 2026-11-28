import { RexControl } from './rex-control'
import { inspectRexRecord } from './rex-inspect-record'
import { providerOwnerPidAbsent } from '../../provider-process/provider-process-row-read'
import { matchesRexRootIdentity } from './rex-root-identity'
import type { RexSessionRecord } from './rex-session-record'
import type { RexSessionStore } from './rex-session-store'

async function verifyRecord(
  endpoint: string,
  record: RexSessionRecord,
  released: boolean
): Promise<boolean> {
  if (record.backend !== 'rex-local' || record.adopted || !record.rootIdentity) {
    return false
  }
  // Interrupted live launch recovery requires more than second-resolution PID evidence.
  const rootMatches = () =>
    record.rootIdentity?.resolution === 'second'
      ? Promise.resolve(false)
      : matchesRexRootIdentity(record)
  const absent = providerOwnerPidAbsent(record.rootPid)
  if (!absent && (!released || !(await rootMatches()))) {
    return false
  }
  const control = await RexControl.connect(endpoint)
  const timer = setTimeout(() => control.close(), 5000)
  try {
    const entry = await inspectRexRecord(control, record)
    // A confirmed dead record can be settled even if the gate release was not recorded.
    // Keep the record for ordinary inventory/reclamation; never close a native block here.
    return absent
      ? entry === null && providerOwnerPidAbsent(record.rootPid)
      : entry !== null && (await rootMatches())
  } finally {
    clearTimeout(timer)
    control.close()
  }
}

/** At most one bounded recovery batch per call; unknown outcomes remain visible as inventory errors. */
export async function recoverRexFreshIntents(
  endpoint: string,
  store: RexSessionStore,
  ids?: readonly string[]
): Promise<void> {
  const deadline = Date.now() + 5000
  const candidates = ids ?? (await store.pendingFreshIds())
  for (const id of new Set(candidates)) {
    if (Date.now() >= deadline) {
      return
    }
    await store
      .recoverFresh(id, (record, _dispatch, released) => verifyRecord(endpoint, record, released))
      .catch(() => false)
  }
}
