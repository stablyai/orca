import { surfacePaneProfileReplacements } from './surface-pane-profile-records'
import { SurfaceBatchRefusal, assertSurfaceBatchAccepted } from './surface-batch-refusal'
import { applyJournalPersistenceEffect } from '../native-chat/agent-session-journal/journal-persistence-unit'
import type {
  JournalPersistenceEffect,
  JournalEffectResult
} from '../native-chat/agent-session-journal/journal-persistence-plan'
import {
  reconcileSurfaceNativeMembership,
  writeSurfaceNativeMemberships
} from './surface-native-membership'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from '../sqlite/sync-database'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import {
  projectSurfaceSession,
  unresolvedSurfaceNativeSessionIds
} from '../../shared/workspace-surfaces/surface-session-projection'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import { writeProfileStateDomainsInTransaction } from '../persistence/profile-state/profile-state-domain-writes'
import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'
import { WorkspaceSurfaceRepository } from './surface-repository'
import {
  captureSurfaceProfileDomain,
  markSurfaceIndices,
  readSurfaceProfileDomain,
  restoreSurfaceIndices,
  surfaceDomainFingerprint
} from './surface-profile-storage'
import { updateTerminalBaselines } from './surface-terminal-baselines'
import { applySurfaceStorageCommand } from './surface-storage-apply'
import {
  readSurfaceHostSession,
  surfaceSessionBatchReplacements
} from './surface-host-profile-session'
import { withProfileStateReadSnapshot } from '../persistence/profile-state/profile-state-read-snapshot'
import {
  readProfileStateRevision,
  ProfileStateRevisionConflictError
} from '../persistence/profile-state/profile-state-documents'

/** One transaction body serves bootstrap and the live profile worker. */
export function executeSurfaceOwnerCommand(
  db: Database.Database,
  expectedRevision: number,
  command: SurfaceStorageCommand,
  mintId: () => string = randomUUID,
  now: () => number = Date.now
): { revision: number; result: SurfaceStorageResult } {
  assertHost(command.hostId)
  if (command.type === 'query') {
    return querySurfaceOwner(db, expectedRevision, command)
  }
  const committed = executeSurfaceOwnerCommands(db, expectedRevision, [command], mintId, now)
  return { revision: committed.revision, result: committed.results[0]! }
}

/** Multi-partition commands share one receipt/content/projection commit and profile revision. */
export function executeSurfaceOwnerCommands(
  db: Database.Database,
  expectedRevision: number,
  commands: readonly Exclude<SurfaceStorageCommand, { type: 'query' }>[],
  mintId: () => string = randomUUID,
  now: () => number = Date.now
): { revision: number; results: SurfaceStorageResult[] } {
  if (commands.length === 0) {
    throw new Error('Surface transaction must contain a command')
  }
  try {
    return withProfileStateWriteTransaction(db, () =>
      applySurfaceOwnerCommandsInTransaction(db, expectedRevision, commands, mintId, now)
    )
  } catch (error) {
    if (!(error instanceof SurfaceBatchRefusal)) {
      throw error
    }
    return {
      revision: expectedRevision,
      results: commands.map(({ hostId }) => ({
        ...querySurfaceOwner(db, expectedRevision, { type: 'query', hostId }).result,
        outcome: error.outcome
      }))
    }
  }
}

/** Internal to the profile executor; callers own the actual BEGIN/COMMIT. */
export function applySurfaceOwnerCommandsInTransaction(
  db: Database.Database,
  expectedRevision: number,
  commands: readonly Exclude<SurfaceStorageCommand, { type: 'query' }>[],
  mintId: () => string = randomUUID,
  now: () => number = Date.now,
  native = false,
  effects: readonly JournalPersistenceEffect[] = []
): { revision: number; results: SurfaceStorageResult[]; values: JournalEffectResult[] } {
  if (!db.isTransaction) {
    throw new Error('Surface transaction body requires its admitted transaction')
  }

  const previous = readSurfaceProfileDomain(db)
  let next = structuredClone(previous)
  restoreSurfaceIndices(db, next, surfaceDomainFingerprint(JSON.stringify(next)))
  const repository = new WorkspaceSurfaceRepository(
    { db, readOnly: false, transaction: (run) => run(db) },
    mintId,
    now
  )
  const sessions = new Map<string, SurfaceStorageResult['session']>()
  const unresolvedNative = new Map<string, { tabId: string; sessionId: string }[]>()
  if (native) {
    for (const hostId of new Set(commands.map((command) => assertHost(command.hostId)))) {
      const host = next.hosts[hostId]
      if (!host?.terminalInitialized) {
        throw new Error('Terminal surfaces must initialize before native membership')
      }
      unresolvedNative.set(
        hostId,
        reconcileSurfaceNativeMembership(
          db,
          repository,
          hostId,
          host,
          readSurfaceHostSession(db, hostId),
          mintId
        )
      )
    }
    next = captureSurfaceProfileDomain(db, next)
  }
  const values = effects.map((effect) => applyJournalPersistenceEffect(db, effect, 'surface_chat'))
  const applied = commands.map((command) => {
    const hostId = assertHost(command.hostId)
    const result = applySurfaceStorageCommand(
      db,
      repository,
      next,
      hostId,
      sessions.get(hostId) ?? readSurfaceHostSession(db, hostId),
      command,
      mintId,
      now
    )
    sessions.set(hostId, result.session)
    return { hostId, outcome: result.outcome }
  })
  assertSurfaceBatchAccepted(applied)
  next = captureSurfaceProfileDomain(db, next)
  if (native) {
    writeSurfaceNativeMemberships(
      db,
      [...sessions.keys()].map((hostId) => [assertHost(hostId), next.hosts[hostId]!] as const),
      mintId,
      unresolvedNative
    )
  }
  for (const [hostId, session] of sessions) {
    const host = next.hosts[hostId]
    if (!host?.terminalInitialized) {
      throw new Error('Surface host must be initialized before accepting commands')
    }
    // Native membership requires the attached journal's common commit, never this terminal-only path.
    if (
      !native &&
      !isDeepStrictEqual(nativeContent(previous, hostId), nativeContent(next, hostId))
    ) {
      throw new Error('Native surface membership requires its journal transaction')
    }
    sessions.set(
      hostId,
      projectSurfaceSession(
        assertHost(hostId),
        session,
        host.surfaces,
        host.chatInitialization === 'verified',
        unresolvedSurfaceNativeSessionIds(host.surfaces, host.chatBaseline?.tabs)
      )
    )
    updateTerminalBaselines(db, next, hostId, mintId)
  }
  const written = writeProfileStateDomainsInTransaction(
    db,
    {
      expectedRevision,
      replacements: [
        ...surfaceSessionBatchReplacements(db, sessions),
        ...surfacePaneProfileReplacements(db, commands, applied)
      ]
    },
    next
  )
  markSurfaceIndices(db, surfaceDomainFingerprint(JSON.stringify(next)))
  return {
    revision: written.revision,
    values,
    results: applied.map(({ hostId, outcome }) => {
      const host = next.hosts[hostId]!
      return {
        hostId,
        host: {
          terminalInitialized: host.terminalInitialized,
          chatInitialization: host.chatInitialization,
          revision: host.revision,
          surfaces: host.surfaces,
          nativeTabs: host.chatBaseline?.tabs
        },
        session: sessions.get(hostId)!,
        allocations: host.allocations,
        outcome
      }
    })
  }
}

function assertHost(hostId: string) {
  const normalized = normalizeExecutionHostId(hostId)
  if (!normalized || normalized !== hostId) {
    throw new Error('Surface command host identity is invalid')
  }
  return normalized
}

function querySurfaceOwner(
  db: Database.Database,
  expectedRevision: number,
  command: Extract<SurfaceStorageCommand, { type: 'query' }>
): { revision: number; result: SurfaceStorageResult } {
  return withProfileStateReadSnapshot(db, () => {
    const revision = readProfileStateRevision(db)
    if (revision !== expectedRevision) {
      throw new ProfileStateRevisionConflictError(expectedRevision, revision)
    }
    const host = readSurfaceProfileDomain(db).hosts[command.hostId]
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
          surfaces: host.surfaces,
          nativeTabs: host.chatBaseline?.tabs
        },
        session: projectSurfaceSession(
          normalizeExecutionHostId(command.hostId)!,
          readSurfaceHostSession(db, command.hostId),
          host.surfaces,
          host.chatInitialization === 'verified',
          unresolvedSurfaceNativeSessionIds(host.surfaces, host.chatBaseline?.tabs)
        ),
        allocations: host.allocations,
        // Missing bounded evidence is unknown, never proof of rejection after a lost reply.
        outcome: receipt?.outcome ?? null
      }
    }
  })
}

function nativeContent(domain: SurfaceProfileDomain, hostId: string): unknown {
  return (
    domain.hosts[hostId]?.surfaces.filter((surface) => surface.content?.kind === 'agent-session') ??
    []
  )
}
