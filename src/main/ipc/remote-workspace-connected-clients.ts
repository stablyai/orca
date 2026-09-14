import type { RemoteWorkspaceConnectedClient } from '../../shared/remote-workspace-types'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { CLIENT_ID, CLIENT_NAME } from './remote-workspace-client-identity'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'

function normalizeConnectedClients(
  raw: unknown,
  currentClientId: string
): RemoteWorkspaceConnectedClient[] {
  const clients = (raw as { clients?: unknown } | null)?.clients
  if (!Array.isArray(clients)) {
    return []
  }
  return clients
    .map((entry): RemoteWorkspaceConnectedClient | null => {
      const item = entry as Partial<RemoteWorkspaceConnectedClient> | null
      const clientId = typeof item?.clientId === 'string' ? item.clientId.trim() : ''
      if (!clientId || clientId.length > 200) {
        return null
      }
      return {
        clientId,
        name:
          typeof item?.name === 'string' && item.name.trim()
            ? item.name.replace(/\s+/g, ' ').trim().slice(0, 80)
            : 'Unknown device',
        lastSeenAt:
          typeof item?.lastSeenAt === 'number' && Number.isFinite(item.lastSeenAt)
            ? item.lastSeenAt
            : 0,
        isCurrent: clientId === currentClientId
      }
    })
    .filter((entry): entry is RemoteWorkspaceConnectedClient => entry !== null)
}

export async function listRemoteWorkspaceConnectedClients(args?: {
  targetIds?: string[]
}): Promise<{ targetId: string; clients: RemoteWorkspaceConnectedClient[] }[]> {
  const requestedTargetIds = Array.isArray(args?.targetIds) ? new Set(args.targetIds) : null
  const targets =
    getSshConnectionStore()
      ?.listTargets()
      .filter(
        (target) =>
          getActiveMultiplexer(target.id) &&
          (!requestedTargetIds || requestedTargetIds.has(target.id))
      ) ?? []
  const results: { targetId: string; clients: RemoteWorkspaceConnectedClient[] }[] = []
  for (const target of targets) {
    const mux = getActiveMultiplexer(target.id)
    if (!mux) {
      continue
    }
    const namespace = getRemoteWorkspaceNamespace(target)
    try {
      const raw = await mux.request('workspace.presence', {
        namespace,
        clientId: CLIENT_ID,
        clientName: CLIENT_NAME
      })
      results.push({
        targetId: target.id,
        clients: normalizeConnectedClients(raw, CLIENT_ID)
      })
    } catch {
      results.push({ targetId: target.id, clients: [] })
    }
  }
  return results
}
