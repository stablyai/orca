import { isActiveLiveAgent } from './live-agent-summary'
import type { LiveAgent } from './live-alert-types'

/** "Done" stays up this long, absorbing the gap between an agent's turns. */
export const DONE_LINGER_MS = 10_000
/** Without fresh rows for this long while agents were running, the session ends as disconnected. */
export const DISCONNECT_END_MS = 90_000

export type LiveSessionInput = {
  now: number
  /** The setting is on and the native side can post notifications. */
  allowed: boolean
  /** Every agent read from any host, including hosts whose data went stale. */
  agents: readonly LiveAgent[]
  /** Hosts whose last read is too old to trust. Their agents keep a session open, never start one. */
  staleHostIds: ReadonlySet<string>
  /** Hosts with old data and a refresh in flight. Their agents never start a session. */
  pendingHostIds: ReadonlySet<string>
  /** Last successful read per host. */
  lastSuccessAt: ReadonlyMap<string, number>
}

export type LiveSessionView = {
  startedAt: number
  sessionKeys: ReadonlySet<string>
}

export type LiveSessionStep =
  | { kind: 'none' }
  | { kind: 'show'; mode: 'live' | 'lingering' | 'disconnected'; session: LiveSessionView }
  | { kind: 'finish'; final: 'done' | 'disconnected'; session: LiveSessionView }
  | { kind: 'cancel' }

type ActiveState = { startedAt: number; keys: Set<string> }

type State =
  | { kind: 'idle' }
  | { kind: 'suppressed' }
  | ({ kind: 'live' } & ActiveState)
  | ({ kind: 'lingering'; since: number } & ActiveState)

const NONE: LiveSessionStep = { kind: 'none' }

function view(state: ActiveState): LiveSessionView {
  return { startedAt: state.startedAt, sessionKeys: new Set(state.keys) }
}

function addKeys(keys: Set<string>, agents: readonly LiveAgent[]): void {
  for (const agent of agents) {
    keys.add(agent.key)
  }
}

/**
 * One live notification session: it starts when an agent becomes active, lingers on "Done" after
 * the last one finishes, and ends. A user dismissal keeps it quiet until no agent is active.
 */
export class LiveAlertsSession {
  private state: State = { kind: 'idle' }

  /** True while the notification is up (live, waiting, disconnected or lingering). */
  isShowing(): boolean {
    return this.state.kind === 'live' || this.state.kind === 'lingering'
  }

  /** The user swiped the notification away or pressed Hide. */
  dismissed(): void {
    this.state = { kind: 'suppressed' }
  }

  step(input: LiveSessionInput): LiveSessionStep {
    const state = this.state
    if (!input.allowed) {
      this.state = { kind: 'idle' }
      return state.kind === 'live' || state.kind === 'lingering' ? { kind: 'cancel' } : NONE
    }
    const current: LiveAgent[] = []
    const stale: LiveAgent[] = []
    for (const agent of input.agents) {
      if (!isActiveLiveAgent(agent)) {
        continue
      }
      if (input.staleHostIds.has(agent.hostId)) {
        stale.push(agent)
      } else {
        current.push(agent)
      }
    }
    switch (state.kind) {
      case 'idle':
        return this.start(input, current)
      case 'suppressed':
        if (current.length === 0) {
          this.state = { kind: 'idle' }
        }
        return NONE
      case 'live':
        return this.stepLive(input, state, current, stale)
      case 'lingering':
        return this.stepLingering(input, state, current)
    }
  }

  private start(input: LiveSessionInput, current: readonly LiveAgent[]): LiveSessionStep {
    // Old rows being refreshed can describe a turn that already ended; wait for the reply.
    if (!current.some((agent) => !input.pendingHostIds.has(agent.hostId))) {
      return NONE
    }
    const next = { kind: 'live' as const, startedAt: input.now, keys: new Set<string>() }
    addKeys(next.keys, current)
    this.state = next
    return { kind: 'show', mode: 'live', session: view(next) }
  }

  private stepLive(
    input: LiveSessionInput,
    state: ActiveState,
    current: readonly LiveAgent[],
    stale: readonly LiveAgent[]
  ): LiveSessionStep {
    addKeys(state.keys, current)
    if (current.length > 0) {
      return { kind: 'show', mode: 'live', session: view(state) }
    }
    // Agents of this session on a host we can no longer read may still be running.
    const unreachable = stale.filter((agent) => state.keys.has(agent.key))
    if (unreachable.length > 0) {
      const lastSeen = Math.max(
        ...unreachable.map((agent) => input.lastSuccessAt.get(agent.hostId) ?? state.startedAt)
      )
      if (input.now - lastSeen >= DISCONNECT_END_MS) {
        this.state = { kind: 'idle' }
        return { kind: 'finish', final: 'disconnected', session: view(state) }
      }
      return { kind: 'show', mode: 'disconnected', session: view(state) }
    }
    this.state = { ...state, kind: 'lingering', since: input.now }
    return { kind: 'show', mode: 'lingering', session: view(state) }
  }

  private stepLingering(
    input: LiveSessionInput,
    state: { since: number } & ActiveState,
    current: readonly LiveAgent[]
  ): LiveSessionStep {
    if (current.length > 0) {
      // A new turn within the linger continues the same session and keeps its clock.
      addKeys(state.keys, current)
      this.state = { kind: 'live', startedAt: state.startedAt, keys: state.keys }
      return { kind: 'show', mode: 'live', session: view(state) }
    }
    if (input.now - state.since >= DONE_LINGER_MS) {
      this.state = { kind: 'idle' }
      return { kind: 'finish', final: 'done', session: view(state) }
    }
    return { kind: 'show', mode: 'lingering', session: view(state) }
  }
}
