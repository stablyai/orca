import { providerOwnerPidAbsent } from '../../provider-process/provider-process-row-read'
import { RexControl } from './rex-control'
import { inspectRexRecord } from './rex-inspect-record'
import type { RexSessionRecord } from './rex-session-record'
import type { RexSessionStore } from './rex-session-store'

function canReclaim(record: RexSessionRecord): boolean {
  return (
    record.backend === 'rex-local' &&
    !record.adopted &&
    !!record.rootIdentity &&
    providerOwnerPidAbsent(record.rootPid)
  )
}

export async function proveNaturalRexExit(
  control: RexControl,
  record: RexSessionRecord
): Promise<boolean> {
  return (
    canReclaim(record) && (await inspectRexRecord(control, record)) === null && canReclaim(record)
  )
}

/** Reclaim only the historical Orca identity. Never close/restart a native block. */
export async function reclaimExitedRexRecord(
  endpoint: string,
  store: RexSessionStore,
  record: RexSessionRecord,
  current: () => boolean
): Promise<boolean> {
  if (!canReclaim(record) || !current()) {
    return false
  }
  await store.read(record.id, record.incarnationId)
  await store.retirements.assertAvailable(record)
  const control = await RexControl.connect(endpoint)
  const timer = setTimeout(() => control.close(), 5000)
  try {
    if (!(await proveNaturalRexExit(control, record)) || !current()) {
      return false
    }
    // The same exclusive retirement fence used by explicit close; only its publisher removes.
    await store.retirements.reserve(record, [], 'natural-exit')
    if (!(await proveNaturalRexExit(control, record)) || !current()) {
      throw new Error('Rex exit changed during reclamation')
    }
    await store.read(record.id, record.incarnationId)
    await store.remove(record.id, record.incarnationId)
    await store.retirements.remove(record)
    return true
  } finally {
    clearTimeout(timer)
    control.close()
  }
}
