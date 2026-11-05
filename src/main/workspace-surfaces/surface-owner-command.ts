import { querySurfaceOwner, assertSurfaceHost, nativeContent } from './surface-owner-read'
import {
  reclaimEmptySurfaces,
  committedSurfaceChanges,
  resourceOnlySurfaceHosts,
  cloneCommandSurfaceHosts,
  trackSurfaceTransaction,
  type SurfaceTransactionChanges
} from './surface-transaction-changes'
import { attachSurfaceEvidenceReader } from './surface-cold-evidence'
import { readSurfaceProfileSnapshot, stageSurfaceProjections } from './surface-profile-cache'
import { SurfaceSessionProjectionCache } from '../../shared/workspace-surfaces/surface-session-projection-cache'
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
  restoreSurfaceIndices,
  surfaceDomainFingerprint
} from './surface-profile-storage'
import { updateTerminalBaselines } from './surface-terminal-baselines'
import { applySurfaceStorageCommand } from './surface-storage-apply'
import {
  readSurfaceHostSession,
  surfaceSessionBatchReplacements
} from './surface-host-profile-session'

/** One transaction body serves bootstrap and the live profile worker. */
export function executeSurfaceOwnerCommand(
  db: Database.Database,
  expectedRevision: number,
  command: SurfaceStorageCommand,
  mintId: () => string = randomUUID,
  now: () => number = Date.now
): { revision: number; result: SurfaceStorageResult } {
  assertSurfaceHost(command.hostId)
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

  const root = readSurfaceProfileSnapshot(db)
  const previous = root.domain
  const next: SurfaceProfileDomain = { ...previous, hosts: { ...previous.hosts } }
  cloneCommandSurfaceHosts(previous, next, commands)
  restoreSurfaceIndices(
    db,
    next,
    root.contentHash ?? surfaceDomainFingerprint(JSON.stringify(next))
  )
  return trackSurfaceTransaction(db, (changes) =>
    applyTrackedSurfaceCommands(
      db,
      expectedRevision,
      commands,
      mintId,
      now,
      native,
      effects,
      root,
      next,
      changes
    )
  )
}

function applyTrackedSurfaceCommands(
  db: Database.Database,
  expectedRevision: number,
  commands: readonly Exclude<SurfaceStorageCommand, { type: 'query' }>[],
  mintId: () => string,
  now: () => number,
  native: boolean,
  effects: readonly JournalPersistenceEffect[],
  root: ReturnType<typeof readSurfaceProfileSnapshot>,
  next: SurfaceProfileDomain,
  transactionChanges: SurfaceTransactionChanges
): { revision: number; results: SurfaceStorageResult[]; values: JournalEffectResult[] } {
  const previous = root.domain
  const repository = new WorkspaceSurfaceRepository(
    { db, readOnly: false, transaction: (run) => run(db) },
    mintId,
    now
  )
  const sessions = new Map<string, SurfaceStorageResult['session']>()
  const unresolvedNative = new Map<string, { tabId: string; sessionId: string }[]>()
  if (native) {
    for (const hostId of new Set(commands.map((command) => assertSurfaceHost(command.hostId)))) {
      const host = next.hosts[hostId]
      if (!host?.terminalInitialized) {
        throw new Error('Terminal surfaces must initialize before native membership')
      }
      attachSurfaceEvidenceReader(db, hostId, host)
      unresolvedNative.set(
        hostId,
        reconcileSurfaceNativeMembership(
          db,
          repository,
          hostId,
          host,
          readSurfaceHostSession(db, hostId),
          mintId,
          commands
        )
      )
    }
    next = captureSurfaceProfileDomain(db, next, transactionChanges)
  }
  const values = effects.map((effect) => applyJournalPersistenceEffect(db, effect, 'surface_chat'))
  const applied = commands.map((command) => {
    const hostId = assertSurfaceHost(command.hostId)
    const result = applySurfaceStorageCommand(
      db,
      repository,
      next,
      hostId,
      sessions.get(hostId) ?? readSurfaceHostSession(db, hostId),
      command,
      mintId,
      now,
      native
    )
    sessions.set(hostId, result.session)
    return { hostId, outcome: result.outcome }
  })
  assertSurfaceBatchAccepted(applied)
  reclaimEmptySurfaces(db, root.domain, transactionChanges)
  next = captureSurfaceProfileDomain(db, next, transactionChanges)
  if (native) {
    writeSurfaceNativeMemberships(
      db,
      [...sessions.keys()].map(
        (hostId) => [assertSurfaceHost(hostId), next.hosts[hostId]!] as const
      ),
      mintId,
      unresolvedNative
    )
  }
  const resourceOnlyHosts = resourceOnlySurfaceHosts(commands, sessions.keys(), previous, next)
  const projections = new Map(root.projections)
  for (const [hostId, session] of sessions) {
    const host = next.hosts[hostId]
    if (!host?.terminalInitialized) {
      throw new Error('Surface host must be initialized before accepting commands')
    }
    if (resourceOnlyHosts.has(hostId)) {
      continue
    }
    // Native membership requires the attached journal's common commit, never this terminal-only path.
    if (
      !native &&
      !isDeepStrictEqual(nativeContent(previous, hostId), nativeContent(next, hostId))
    ) {
      throw new Error('Native surface membership requires its journal transaction')
    }
    const projection = new SurfaceSessionProjectionCache(
      host.surfaces,
      root.projections.get(hostId)
    )
    projections.set(hostId, projection)
    sessions.set(
      hostId,
      projectSurfaceSession(
        assertSurfaceHost(hostId),
        session,
        host.surfaces,
        host.chatInitialization === 'verified',
        unresolvedSurfaceNativeSessionIds(host.surfaces, host.chatBaseline?.tabs),
        new Set(
          commands.flatMap((command) => {
            if (command.hostId !== hostId) {
              return []
            }
            if (command.type === 'show-native') {
              return [command.sessionId]
            }
            return command.type === 'replace' && command.request.content?.kind === 'agent-session'
              ? [command.request.content.sessionId]
              : []
          })
        ),
        projection
      )
    )
    updateTerminalBaselines(
      db,
      next,
      hostId,
      mintId,
      commands.some((command) => command.hostId === hostId && command.type === 'initialize')
        ? undefined
        : new Set(
            [...(transactionChanges.surfaces.get(hostId)?.keys() ?? [])].map((key) =>
              String(JSON.parse(key)[0])
            )
          )
    )
  }
  const changes = committedSurfaceChanges(sessions.keys(), transactionChanges)
  const written = writeProfileStateDomainsInTransaction(
    db,
    {
      expectedRevision,
      replacements: [
        ...surfaceSessionBatchReplacements(
          db,
          new Map([...sessions].filter(([hostId]) => !resourceOnlyHosts.has(hostId)))
        ),
        ...surfacePaneProfileReplacements(db, commands, applied)
      ]
    },
    next,
    false,
    transactionChanges
  )
  stageSurfaceProjections(db, projections)
  markSurfaceIndices(db, readSurfaceProfileSnapshot(db).contentHash!)
  return {
    revision: written.revision,
    values,
    results: applied.map(({ hostId, outcome }) => {
      const host = next.hosts[hostId]!
      return {
        hostId,
        changes: changes.get(hostId)!,
        ...(resourceOnlyHosts.has(hostId) ? { changedWorkspaces: [] } : {}),
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
