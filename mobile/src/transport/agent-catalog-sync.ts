// Why: mobile's per-host cache of the runtime agent catalog. The host owns the
// catalog; mobile only mirrors the env-free revisioned snapshot it publishes on
// `settings.agentCatalog.get` (falling back to the legacy `settings.get`
// piggyback against old hosts), refetching on `agentCatalogChanged` events.
// Never merges with local state and never carries a custom env key or value
// (env-free by DTO construction — no fields are added here).
import type { RpcClient } from './rpc-client'
import type { RpcResponse, RpcSuccess } from './types'
import type {
  AgentCatalogProjectionError,
  AgentCatalogSnapshot
} from '../../../src/shared/agent-catalog-snapshot'
import {
  createRevisionedSnapshotSync,
  type SnapshotFetchOutcome,
  type SnapshotSyncConnection
} from './revisioned-snapshot-sync'

// The full snapshot or its oversize projection error. Both carry version:1 (the
// client's identity-launch capability signal) and a revision.
export type AgentCatalogValue = AgentCatalogSnapshot | AgentCatalogProjectionError

function parseCatalogValue(raw: unknown): AgentCatalogValue | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const candidate = raw as { version?: unknown; revision?: unknown }
  if (candidate.version !== 1 || typeof candidate.revision !== 'number') {
    return null
  }
  return raw as AgentCatalogValue
}

async function sendCatalogRead(client: RpcClient, method: string): Promise<RpcResponse | null> {
  try {
    return (await client.sendRequest(method)) ?? null
  } catch {
    return null
  }
}

// Mobile's method allowlist is checked before dispatch, so a host that predates
// the dedicated read rejects it with 'forbidden' rather than 'method_not_found'.
function isMethodUnavailable(response: RpcResponse | null): boolean {
  const error = response && !response.ok ? response.error : undefined
  return (
    error?.code === 'forbidden' ||
    error?.code === 'method_not_found' ||
    error?.message.includes('not available to mobile clients') === true
  )
}

function readCatalog(response: RpcSuccess): SnapshotFetchOutcome<AgentCatalogValue> {
  const result = response.result as { agentCatalog?: unknown } | null
  const runtimeId = (response as { _meta?: { runtimeId?: string } })._meta?.runtimeId ?? ''
  const value = parseCatalogValue(result?.agentCatalog)
  if (!value) {
    // The host answered without a catalog: it publishes none (it was downgraded,
    // or predates the catalog). Keeping the cached one would leave the picker
    // offering custom agents the host can no longer launch.
    return { kind: 'absent', runtimeId }
  }
  return { kind: 'value', runtimeId, value }
}

async function fetchCatalog(client: RpcClient): Promise<SnapshotFetchOutcome<AgentCatalogValue>> {
  const dedicated = await sendCatalogRead(client, 'settings.agentCatalog.get')
  if (dedicated?.ok) {
    return readCatalog(dedicated)
  }
  if (!isMethodUnavailable(dedicated)) {
    return { kind: 'unavailable' }
  }
  // Old host: the catalog ships only piggybacked on settings.get.
  const legacy = await sendCatalogRead(client, 'settings.get')
  return legacy?.ok ? readCatalog(legacy) : { kind: 'unavailable' }
}

const sync = createRevisionedSnapshotSync<AgentCatalogValue>()

export const agentCatalogSync = {
  getSnapshot: sync.getSnapshot,
  subscribe: sync.subscribe,
  clear: sync.clear,
  openConnection(hostId: string, client: RpcClient): SnapshotSyncConnection {
    return sync.openConnection(hostId, () => fetchCatalog(client))
  }
}
