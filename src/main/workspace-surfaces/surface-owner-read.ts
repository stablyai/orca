import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import { readSurfaceHostSession } from './surface-host-profile-session'
import {
  projectSurfaceSession,
  unresolvedSurfaceNativeSessionIds
} from '../../shared/workspace-surfaces/surface-session-projection'
import type Database from '../sqlite/sync-database'
import type {
  SurfaceStorageRead,
  SurfaceStorageReadResult
} from '../../shared/workspace-surfaces/surface-storage-read'
import { readSurfaceProfileSnapshot } from './surface-profile-cache'
import { withProfileStateReadSnapshot } from '../persistence/profile-state/profile-state-read-snapshot'
import {
  readProfileStateRevision,
  ProfileStateRevisionConflictError
} from '../persistence/profile-state/profile-state-documents'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { sameRunTarget } from '../../shared/workspace-surfaces/surface-allocation'

export function readSurfaceOwner(
  db: Database.Database,
  expectedRevision: number,
  request: SurfaceStorageRead
): { revision: number; result: SurfaceStorageReadResult } {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    if (revision !== expectedRevision) {
      throw new ProfileStateRevisionConflictError(expectedRevision, revision)
    }
    if (
      normalizeExecutionHostId(request.hostId) !== request.hostId ||
      (request.type === 'run' && request.target.hostId !== request.hostId)
    ) {
      throw new Error('Surface read crosses execution hosts')
    }
    const root = readSurfaceProfileSnapshot(db)
    if (!root.domain.hosts[request.hostId]?.terminalInitialized) {
      throw new Error('Surface host must initialize before reading')
    }
    const index = root.hosts.get(request.hostId)!
    const stamp = {
      profileRevision: revision,
      rootRevision: root.revision,
      rootHash: root.contentHash
    }
    if (request.type === 'receipt') {
      return {
        revision,
        result: {
          ...stamp,
          type: 'receipt',
          receipt: structuredClone(
            index.receipts.get(JSON.stringify([request.callerId, request.commandId])) ?? null
          )
        }
      }
    }
    const allocation = index.allocations.get(request.target.runId) ?? null
    if (allocation && !sameRunTarget(allocation.target, request.target)) {
      throw new Error('Surface allocation target is inconsistent')
    }
    return {
      revision,
      result: {
        ...stamp,
        type: 'run',
        surface: structuredClone(
          index.surfaces.get(
            JSON.stringify([request.target.workspaceId, request.target.hostTabId])
          ) ?? null
        ),
        allocation: structuredClone(allocation)
      }
    }
  })
}

export function assertSurfaceHost(hostId: string) {
  const normalized = normalizeExecutionHostId(hostId)
  if (!normalized || normalized !== hostId) {
    throw new Error('Surface command host identity is invalid')
  }
  return normalized
}

export function querySurfaceOwner(
  db: Database.Database,
  expectedRevision: number,
  command: Extract<SurfaceStorageCommand, { type: 'query' }>
): { revision: number; result: SurfaceStorageResult } {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    if (revision !== expectedRevision) {
      throw new ProfileStateRevisionConflictError(expectedRevision, revision)
    }
    const host = readSurfaceProfileSnapshot(db).domain.hosts[command.hostId]
    if (!host?.terminalInitialized) {
      throw new Error('Surface host must be initialized before querying commands')
    }
    const receipt =
      command.command &&
      host.receipts.find(
        (entry) =>
          entry.callerId === command.command!.callerId &&
          entry.commandId === command.command!.commandId
      )
    return {
      revision,
      result: {
        hostId: command.hostId,
        host: {
          terminalInitialized: host.terminalInitialized,
          chatInitialization: host.chatInitialization,
          revision: host.revision,
          surfaces: structuredClone(host.surfaces),
          nativeTabs: structuredClone(host.chatBaseline?.tabs)
        },
        session: projectSurfaceSession(
          normalizeExecutionHostId(command.hostId)!,
          readSurfaceHostSession(db, command.hostId),
          host.surfaces,
          host.chatInitialization === 'verified',
          unresolvedSurfaceNativeSessionIds(host.surfaces, host.chatBaseline?.tabs)
        ),
        allocations: structuredClone(host.allocations),
        // Missing bounded evidence is unknown, never proof of rejection after a lost reply.
        outcome: structuredClone(receipt?.outcome ?? null)
      }
    }
  })
}

export function nativeContent(domain: SurfaceProfileDomain, hostId: string): unknown {
  return (
    domain.hosts[hostId]?.surfaces.filter((surface) => surface.content?.kind === 'agent-session') ??
    []
  )
}
