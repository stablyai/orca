// Why: mobile's per-host cache of the runtime agent-reference snapshot (terminal
// quick commands, commit-message and Source Control agent choices). `settings.get`
// only carries a lightweight `agentReferences` revision descriptor; the full
// snapshot comes from `settings.agentReferences.get`, refetched on
// `agentReferencesChanged` events. Full replacement, never merged with local state.
import type { RpcClient } from './rpc-client'
import type {
  AgentReferenceProjectionError,
  AgentReferenceSnapshot
} from '../../../src/shared/agent-reference-snapshot'
import {
  createRevisionedSnapshotSync,
  type SnapshotFetchOutcome,
  type SnapshotSyncConnection
} from './revisioned-snapshot-sync'

// The full snapshot or its oversize projection error; both carry version:1 and a
// revision.
export type AgentReferenceValue = AgentReferenceSnapshot | AgentReferenceProjectionError

function parseReferenceValue(raw: unknown): AgentReferenceValue | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const candidate = raw as { version?: unknown; revision?: unknown }
  if (candidate.version !== 1 || typeof candidate.revision !== 'number') {
    return null
  }
  return raw as AgentReferenceValue
}

async function fetchReferences(
  client: RpcClient
): Promise<SnapshotFetchOutcome<AgentReferenceValue>> {
  let response
  try {
    response = await client.sendRequest('settings.agentReferences.get')
  } catch {
    return { kind: 'unavailable' }
  }
  if (!response || !response.ok) {
    return { kind: 'unavailable' }
  }
  const result = response.result as { agentReferences?: unknown } | null
  const runtimeId = (response as { _meta?: { runtimeId?: string } })._meta?.runtimeId ?? ''
  const value = parseReferenceValue(result?.agentReferences)
  if (!value) {
    // The call succeeded but carries no snapshot, so this host publishes none —
    // an old host answers method_not_found instead, which stays 'unavailable'.
    return { kind: 'absent', runtimeId }
  }
  return { kind: 'value', runtimeId, value }
}

const sync = createRevisionedSnapshotSync<AgentReferenceValue>()

export const agentReferenceSync = {
  getSnapshot: sync.getSnapshot,
  subscribe: sync.subscribe,
  clear: sync.clear,
  openConnection(hostId: string, client: RpcClient): SnapshotSyncConnection {
    return sync.openConnection(hostId, () => fetchReferences(client))
  }
}
