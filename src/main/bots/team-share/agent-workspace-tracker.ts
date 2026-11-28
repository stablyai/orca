// A stream's live copy of a shared agent's workspace set (`agentWorkspaceSet`) for a workspace
// teammate, re-read as the host's workspaces change, and the order its events and tab changes are
// judged in.
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  agentHasWorkspace,
  type AgentWorkspaceSet
} from '../../runtime/workspaces/process-listing/agent-workspace-set'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { RpcContext } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { teammateClientEvent } from './teammate-client-events'

type TrackerRuntime = Pick<OrcaRuntimeService, 'readAgentWorkspaceSet' | 'onClientEvent'>

export const NO_WORKSPACES: AgentWorkspaceSet = {
  homeKey: 'folder:',
  keys: new Set(),
  repoIds: new Set(),
  groupIds: new Set()
}

/** The workspace teammate's scope, or null for anyone else. */
export function workspaceTeammateOf(
  context: Pick<RpcContext, 'callerScope'>
): BotShareCallerScope | null {
  const scope = context.callerScope
  return scope?.kind === 'bot-share' && scope.workspaceTier === true ? scope : null
}

export async function readTeammateWorkspaceSet(
  runtime: Pick<OrcaRuntimeService, 'readAgentWorkspaceSet'>,
  scope: BotShareCallerScope
): Promise<AgentWorkspaceSet> {
  return (await runtime.readAgentWorkspaceSet(scope.botId)) ?? NO_WORKSPACES
}

/** A tracker for the stream, read once; built before the stream listens so a new worker workspace is
 *  in the set before its own changes arrive. */
export async function openTracker(
  context: Pick<RpcContext, 'callerScope' | 'runtime' | 'signal'>
): Promise<AgentWorkspaceTracker | null> {
  const scope = workspaceTeammateOf(context)
  if (!scope) {
    return null
  }
  const tracker = new AgentWorkspaceTracker(context.runtime, scope)
  await tracker.ready()
  if (context.signal?.aborted) {
    tracker.dispose()
    throw new Error('client_disconnected')
  }
  return tracker
}

// Events after which the set may have grown or shrunk: a worktree, repo, Dispatch or bot changed.
function movesTheSet(event: RuntimeClientEvent): boolean {
  return (
    event.type === 'worktreesChanged' ||
    event.type === 'reposChanged' ||
    event.type === 'agentOrchestrationChanged' ||
    (event.type === 'botsChanged' &&
      (event.kinds === undefined || event.kinds.includes('workers') || event.kinds.includes('bot')))
  )
}

const sameKeys = (left: AgentWorkspaceSet, right: AgentWorkspaceSet) =>
  left.keys.size === right.keys.size && [...left.keys].every((key) => right.keys.has(key))

/** A stream's live copy of the set: read once, then again after each event that may move it, a
 *  burst coalesced to one read in flight and one after it. Work handed to `after` runs in arrival
 *  order, behind any read pending when it arrived, so an event that added a workspace is judged
 *  against the set that has it, and one that removed it against the set before (`before`). */
export class AgentWorkspaceTracker {
  private set: AgentWorkspaceSet = NO_WORKSPACES
  private previous: AgentWorkspaceSet = NO_WORKSPACES
  private reading: Promise<void>
  private readsPending = 1
  private rereadQueued = false
  private queue: Promise<void> = Promise.resolve()
  private queued = 0
  private readonly changed = new Set<(before: AgentWorkspaceSet, now: AgentWorkspaceSet) => void>()
  private readonly stopListening: () => void

  constructor(
    private readonly runtime: TrackerRuntime,
    readonly scope: BotShareCallerScope
  ) {
    this.reading = this.read()
    // Registered before any stream's own listener, so a stream sees this event's read already pending.
    this.stopListening = runtime.onClientEvent((event) => {
      if (movesTheSet(event)) {
        this.reread()
      }
    })
  }

  ready(): Promise<void> {
    return this.reading
  }

  has(id: string | null | undefined): boolean {
    return agentHasWorkspace(this.set, id)
  }

  current(): AgentWorkspaceSet {
    return this.set
  }

  /** Runs `work` in arrival order, after any read pending when it arrived. */
  after(work: () => void): void {
    if (this.queued === 0 && this.readsPending === 0) {
      work()
      return
    }
    this.queued += 1
    this.queue = this.queue
      .then(() => this.reading)
      .then(work)
      // A closed stream's emit may throw; the work after it still runs in order.
      .catch(() => undefined)
      .finally(() => {
        this.queued -= 1
      })
  }

  /** Each event judged in arrival order against the set as of it. When the set itself moves (a
   *  worker workspace made, removed or newly parented), its repos' lists are re-read. */
  orderedClientEvents(
    emit: (event: RuntimeClientEvent) => void
  ): (event: RuntimeClientEvent) => void {
    this.changed.add((before, now) => {
      for (const repoId of new Set([...before.repoIds, ...now.repoIds])) {
        emit({ type: 'worktreesChanged', repoId })
      }
      if (
        before.repoIds.size !== now.repoIds.size ||
        ![...before.repoIds].every((id) => now.repoIds.has(id))
      ) {
        emit({ type: 'reposChanged' })
      }
    })
    return (event) =>
      this.after(() => {
        const kept = teammateClientEvent(event, {
          now: this.set,
          before: this.previous,
          botId: this.scope.botId
        })
        if (kept) {
          emit(kept)
        }
      })
  }

  private reread(): void {
    if (this.rereadQueued) {
      return
    }
    this.rereadQueued = true
    this.readsPending += 1
    this.reading = this.reading.then(() => {
      this.rereadQueued = false
      return this.read()
    })
  }

  private async read(): Promise<void> {
    const next = await readTeammateWorkspaceSet(this.runtime, this.scope).catch(() => this.set)
    const before = this.set
    this.previous = before
    this.set = next
    this.readsPending -= 1
    if (before !== NO_WORKSPACES && !sameKeys(before, next)) {
      for (const listener of this.changed) {
        listener(before, next)
      }
    }
  }

  dispose(): void {
    this.stopListening()
    this.changed.clear()
  }
}
