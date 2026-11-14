import { borrowWorkspaceSession } from '../../persistence/loading-store/workspace-sessions/session-host-partitions'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { partitionHoldsWorktree } from '../workspaces/session-hosts/twin-repo-session-host'

type LabelBaseline = {
  hostId: ExecutionHostId | null
  claims: Map<ExecutionHostId, number>
  aliases: Map<string, string | null>
}

function routeClaim(session: WorkspaceSessionState | undefined, workspaceId: string): number {
  return (
    (partitionHoldsWorktree(session, workspaceId) ? 1 : 0) |
    ((session?.tabsByWorktree[workspaceId]?.length ?? 0) > 0 ? 2 : 0)
  )
}

function savedAliases(session: WorkspaceSessionState | undefined, workspaceId: string) {
  const aliases = new Map<string, string | null>()
  for (const tab of session?.unifiedTabs?.[workspaceId] ?? []) {
    if (tab.contentType === 'agent-session' && !aliases.has(tab.entityId)) {
      aliases.set(tab.entityId, tab.customLabel?.trim() || null)
    }
  }
  return aliases
}

/** Compatibility boundary for full window saves; retain only cached workspaces' title inputs. */
export class StructuredConversationLabelChanges {
  private readonly workspaces = new Map<string, LabelBaseline>()

  constructor(
    private readonly store: RuntimeStore | null,
    private readonly resolveHost: (workspaceId: string) => ExecutionHostId | null
  ) {}

  seed(workspaceId: string): void {
    if (this.workspaces.has(workspaceId)) {
      return
    }
    const hostId = this.resolveHost(workspaceId)
    const claims = new Map<ExecutionHostId, number>()
    for (const id of new Set<ExecutionHostId>([
      'local',
      ...(this.store?.getWorkspaceSessionHostIds?.() ?? [])
    ])) {
      const claim = routeClaim(borrowWorkspaceSession(this.store, id), workspaceId)
      if (claim !== 0) {
        claims.set(id, claim)
      }
    }
    this.workspaces.set(workspaceId, {
      hostId,
      claims,
      aliases: savedAliases(
        hostId ? borrowWorkspaceSession(this.store, hostId) : undefined,
        workspaceId
      )
    })
  }

  aliasesFor(workspaceId: string): ReadonlyMap<string, string | null> | undefined {
    return this.workspaces.get(workspaceId)?.aliases
  }

  forget(workspaceId: string): void {
    this.workspaces.delete(workspaceId)
  }

  reconcile(
    writtenHost: ExecutionHostId | null,
    routesDirty: boolean
  ): Map<string, Map<string, string | null>> {
    const changes = new Map<string, Map<string, string | null>>()
    if (this.workspaces.size === 0) {
      return changes
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState | undefined>()
    const sessionFor = (id: ExecutionHostId) => {
      if (!sessions.has(id)) {
        sessions.set(id, borrowWorkspaceSession(this.store, id))
      }
      return sessions.get(id)
    }
    const hosts =
      writtenHost === null
        ? new Set<ExecutionHostId>(['local', ...(this.store?.getWorkspaceSessionHostIds?.() ?? [])])
        : new Set([writtenHost])
    for (const [workspaceId, baseline] of this.workspaces) {
      let reroute = routesDirty || writtenHost === null
      if (writtenHost === null) {
        for (const id of baseline.claims.keys()) {
          if (!hosts.has(id)) {
            baseline.claims.delete(id)
          }
        }
      }
      for (const id of hosts) {
        const claim = routeClaim(sessionFor(id), workspaceId)
        if ((baseline.claims.get(id) ?? 0) !== claim) {
          reroute = true
        }
        if (claim === 0) {
          baseline.claims.delete(id)
        } else {
          baseline.claims.set(id, claim)
        }
      }
      if (reroute) {
        baseline.hostId = this.resolveHost(workspaceId)
      }
      if (!reroute && baseline.hostId !== writtenHost) {
        continue
      }
      const aliases = savedAliases(
        baseline.hostId ? sessionFor(baseline.hostId) : undefined,
        workspaceId
      )
      const changed = new Map<string, string | null>()
      for (const id of new Set([...baseline.aliases.keys(), ...aliases.keys()])) {
        const alias = aliases.get(id) ?? null
        if ((baseline.aliases.get(id) ?? null) !== alias) {
          changed.set(id, alias)
        }
      }
      baseline.aliases = aliases
      if (changed.size > 0) {
        changes.set(workspaceId, changed)
      }
    }
    return changes
  }
}
