import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  orphanSurfaceRetirements,
  assertOrphanRetirementsAccepted
} from './surface-orphan-retirement'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { agentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { SurfaceStorageMutation } from '../../shared/workspace-surfaces/surface-storage-command'
import type { WorkspaceSurfaceCommands } from '../persistence/loading-store/workspace-surface-commands'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalPersistencePlan } from '../native-chat/agent-session-journal/journal-persistence-plan'
import type { SurfaceJointResult } from './surface-joint-transaction'

export type SurfaceNativeRuntimeOwner = Pick<
  WorkspaceSurfaceCommands,
  | 'readWorkspaceSurfaces'
  | 'executeWorkspaceSurfaceJournalUnit'
  | 'readDeregisteredWorkspaceSurfaces'
>

/** Import once before loading the record mirror; all later visibility writes use this same lane. */
export async function installSurfaceNativeRuntimeOwner(
  journal: JournalHostDatabase,
  owner: SurfaceNativeRuntimeOwner,
  host: string
): Promise<void> {
  const hostId = normalizeExecutionHostId(host)
  if (!hostId) {
    throw new Error('Native surface host is invalid')
  }
  if (journal.readOnly) {
    return
  }
  const commit = (
    commands: readonly SurfaceStorageMutation[],
    committed: Parameters<NonNullable<JournalHostDatabase['surfaceCommands']>>[1],
    admit?: () => void,
    afterCommitted?: (result: SurfaceJointResult) => void
  ) =>
    journal.jointPrepared<SurfaceJointResult>(
      (journalPath, settle) =>
        owner.executeWorkspaceSurfaceJournalUnit(
          { journalPath, commands },
          [],
          (result, publish) =>
            settle(result, () => publish((notify) => journal.notifyCommitted(notify))),
          admit,
          afterCommitted
        ),
      committed
    )
  await commit([{ type: 'initialize', hostId }], () => {})
  const readOrphans = () =>
    owner
      .readDeregisteredWorkspaceSurfaces()
      .filter((surface) => surface.hostId === hostId && surface.content?.kind === 'agent-session')
  const orphans = structuredClone(readOrphans())
  if (orphans.length) {
    const result = await commit(
      orphanSurfaceRetirements(orphans),
      () => {},
      () => {
        if (!isDeepStrictEqual(orphans, readOrphans())) {
          throw new Error('Workspace ownership changed while opening chat storage')
        }
      }
    )
    assertOrphanRetirementsAccepted(result.surfaces)
  }
  journal.surfaceCommands = commit
  journal.surfaceOwner = (plan, journalPath, committed) => {
    const commands = nativeMembershipCommands(owner, hostId, plan)
    const effects = plan.effects.map((effect) =>
      effect.kind === 'store'
        ? { ...effect, writes: { ...effect.writes, sessionTabs: null } }
        : effect
    )
    return owner.executeWorkspaceSurfaceJournalUnit(
      { journalPath, commands },
      effects,
      (result, publish) =>
        committed(result, () => publish((notify) => journal.notifyCommitted(notify)))
    )
  }
}

function nativeMembershipCommands(
  owner: SurfaceNativeRuntimeOwner,
  hostId: ExecutionHostId,
  plan: JournalPersistencePlan
): SurfaceStorageMutation[] {
  const surfaces = owner.readWorkspaceSurfaces(hostId)
  const bySession = new Map(
    surfaces.flatMap((surface) =>
      surface.content?.kind === 'agent-session'
        ? [[surface.content.sessionId, surface] as const]
        : []
    )
  )
  const changes = new Map<string, { before?: string; after?: string }>()
  for (const change of plan.memberships) {
    const before = new Map(change.before.map(({ sessionId, tabId }) => [sessionId, tabId]))
    const after = new Map(change.after.map(({ sessionId, tabId }) => [sessionId, tabId]))
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) === after.get(id)) {
        continue
      }
      const prior = changes.get(id)
      changes.set(id, { before: prior ? prior.before : before.get(id), after: after.get(id) })
    }
  }
  const commands: SurfaceStorageMutation[] = []
  const identity = () => ({
    hostId,
    callerId: 'native-membership',
    commandId: randomUUID(),
    expiresAt: Date.now() + 60_000
  })
  for (const [sessionId, change] of changes) {
    const current = bySession.get(sessionId)
    if (change.before && current && current.hostTabId !== change.before) {
      throw agentSessionRefusalError('agent_session_conflict', { reason: 'tabIdTaken' })
    }
    if (!change.after) {
      if (current) {
        commands.push({
          type: 'replace',
          hostId,
          request: {
            ...identity(),
            workspaceId: current.workspaceId,
            hostTabId: current.hostTabId,
            expected: { occurrence: current.occurrence, revision: current.revision },
            content: null
          }
        })
      }
      continue
    }
    if (current?.hostTabId === change.after) {
      continue
    }
    commands.push({
      type: 'show-native',
      hostId,
      sessionId,
      hostTabId: change.after,
      expected: current
        ? {
            workspaceId: current.workspaceId,
            hostTabId: current.hostTabId,
            occurrence: current.occurrence,
            revision: current.revision
          }
        : null,
      identity: identity()
    })
  }
  return commands.length ? commands : [{ type: 'initialize', hostId }]
}
