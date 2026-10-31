import type { OrcaSessionId } from '../../../../shared/orca-session-address'
import type { OrchestrationCoordinatorKey } from '../orchestration-caller-identity'
import {
  structuredWorkerIdentities,
  structuredWorkerIdentityFromRow,
  structuredWorkerProcessIncarnation,
  structuredWorkerRecordIsCurrent,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { deriveWorkerTerminalListState } from '../worker-terminal-ownership'
import type { createLineageRunningSessionResolver } from '../structured-session-lineage'
import { sessionPartyFromWorkerIdentity } from '../orchestration-party'
import type { crewRecipientOwnerQueries, DispatchInput } from './crew-recipient-owner-queries'

export type CrewRecipientKey = OrchestrationCoordinatorKey & { address: string; sourceKey?: string }
type Key = CrewRecipientKey

export function heldCrewDispatchWorker(
  handle: string,
  resource: DispatchInput['nested_resource'],
  running: ReturnType<typeof createLineageRunningSessionResolver>,
  listed: ReadonlySet<string>
): StructuredWorkerIdentity | null {
  const identity =
    structuredWorkerIdentities.get(handle) ??
    (resource ? structuredWorkerIdentityFromRow(resource) : null)
  const live = identity ? running(identity.sessionId) : null
  return live?.kind === 'here' &&
    structuredWorkerRecordIsCurrent(
      live.record,
      live.record.ownerObservation.claimStatus === 'released' && listed.has(live.sessionId)
    ) &&
    resource?.release_state !== 'released'
    ? identity
    : null
}

/** Registry precedence and durable custody remain source facts of the same host generation. */
export function createCrewRecipientWorkerFacts(
  query: ReturnType<typeof crewRecipientOwnerQueries>,
  running: ReturnType<typeof createLineageRunningSessionResolver>,
  canonical: (id: OrcaSessionId) => OrcaSessionId,
  visibility: () => ReadonlySet<string>
) {
  const identities = new Map<
    string,
    { identity: StructuredWorkerIdentity | null; recorded: boolean; held: boolean }
  >()
  const rootOf = (id: OrcaSessionId) => canonical(id)
  const keyFor = (id: OrcaSessionId): Key | undefined => {
    const root = rootOf(id)
    const fact = identities.get(root)
    return fact ? sessionPartyFromWorkerIdentity(root, fact.identity, fact.recorded) : undefined
  }
  const prepareIdentities = (ids: OrcaSessionId[]) => {
    const missing = [...new Set(ids.map(rootOf))].filter((id) => !identities.has(id))
    if (!missing.length) {
      return
    }
    const listed = visibility()
    const known = new Map(
      missing.map((id) => [id, structuredClone(structuredWorkerIdentities.getBySessionId(id))])
    )
    const request = missing.map((root) => ({
      root,
      incarnation: structuredWorkerProcessIncarnation(root),
      handle: known.get(root)?.handle ?? null
    }))
    const rows = query.identity(request)
    for (const row of rows) {
      const identity =
        known.get(row.root) ??
        (row.identity_resource ? structuredWorkerIdentityFromRow(row.identity_resource) : null)
      const live = identity ? running(identity.sessionId) : null
      // Resource release is the only custody state that refuses addressability.
      const custody = row.custody_resource
        ? deriveWorkerTerminalListState({
            workerState: row.owner_state,
            agentTerminalHandle: row.custody_resource.terminal_handle,
            resource: row.custody_resource
          })
        : null
      identities.set(row.root, {
        identity,
        recorded: Boolean(row.recorded),
        held:
          live?.kind === 'here' &&
          structuredWorkerRecordIsCurrent(
            live.record,
            live.record.ownerObservation.claimStatus === 'released' && listed.has(live.sessionId)
          ) &&
          custody !== 'released'
      })
    }
  }
  const livePane = (key: Key) =>
    key.orcaSessionId && identities.get(key.orcaSessionId)?.held
      ? (key.paneKey ?? undefined)
      : undefined
  return {
    keyFor,
    prepare: prepareIdentities,
    livePane,
    covered: (id: OrcaSessionId) => identities.has(rootOf(id))
  }
}
