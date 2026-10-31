import { isStructuredWorkerHandle } from '../../../../shared/structured-worker-handle'
import {
  dispatchAssigneeCoordinatorKey,
  selectRunBoundDispatchRecipient
} from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { federatedControlMailRefusal } from '../../rpc/methods/orchestration/messaging/send-control-mail'
import type { createLineageRunningSessionResolver } from '../structured-session-lineage'
import type { DispatchInput } from './crew-recipient-owner-queries'
import type { CrewRecipientTerminal } from './crew-recipient-inputs'
import { heldCrewDispatchWorker, type CrewRecipientKey } from './crew-recipient-worker-facts'

/** Both command forms use the same process-qualified selected nested-Run input. */
export function prepareCrewDispatchRecipients(
  selected: Iterable<DispatchInput>,
  terminal: CrewRecipientTerminal,
  running: ReturnType<typeof createLineageRunningSessionResolver>,
  listed: () => ReadonlySet<string>,
  currentRuns: (keys: CrewRecipientKey[]) => void
) {
  const nested = new Map<string, CrewRecipientKey>()
  for (const row of selected) {
    let held: ReturnType<typeof heldCrewDispatchWorker> = null
    const key = dispatchAssigneeCoordinatorKey(
      row,
      () => row.protocol_version !== null,
      (handle) => {
        if (!isStructuredWorkerHandle(handle)) {
          return terminal.livePane(handle)
        }
        held = heldCrewDispatchWorker(handle, row.nested_resource, running, listed())
        return held?.paneKey ?? null
      },
      (handle) =>
        isStructuredWorkerHandle(handle)
          ? (held?.processIncarnation ?? null)
          : terminal.process(handle)
    )
    if (key) {
      nested.set(row.id, { ...key, address: `nested:${row.id}` })
    }
  }
  currentRuns([...nested.values()])
  return nested
}

export function crewDispatchRecipientAvailable(
  row: DispatchInput,
  boundRun: { id: string } | undefined
) {
  if (row.protocol_version !== null) {
    return !federatedControlMailRefusal(
      row.id,
      row.protocol_version,
      () => row.worker_state ?? undefined
    )
  }
  // The command rejects a settled explicit mailbox before considering its nested redirect.
  if (row.status !== 'pending' && row.status !== 'dispatched') {
    return false
  }
  const redirected = selectRunBoundDispatchRecipient(row, boundRun)
  return Boolean(redirected || row.status === 'pending' || row.status === 'dispatched')
}
