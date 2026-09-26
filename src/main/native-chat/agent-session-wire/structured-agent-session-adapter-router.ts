import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type RoutedAgent = 'claude' | 'codex'
type SessionRoute = { adapter: StructuredAgentSessionAdapter; state: 'live' | 'stopped' }

export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly routes = new Map<string, SessionRoute>()
  private allAdaptersClosed = false
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly adapters: Record<RoutedAgent, StructuredAgentSessionAdapter>,
    private readonly closeAdapters: () => Promise<void>
  ) {}

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    const adapter = this.adapterForAgent(agent)
    return adapter ? (adapter.supportsLocation?.(location) ?? false) : false
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    Object.values(this.adapters).some((adapter) => adapter.supportsLocation?.(location) ?? false)

  /** Both adapters already gate their own shutdown, so the router only has to stop UNDOING that:
   *  a late acquire must not clear `allAdaptersClosed` and fan a session back out to closed
   *  adapters. Once closed, the router stays closed. */
  async acquire(input: Parameters<StructuredAgentSessionAdapter['acquire']>[0]) {
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    const adapter = this.requireAgent(input.identity)
    const acquired = await adapter.acquire(input)
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    this.routes.set(input.identity.sessionId, { adapter, state: 'live' })
    return acquired
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    const route = this.routes.get(input.sessionId)
    if (route) {
      try {
        return (await route.adapter.releaseAcquisition?.(input)) === true
      } finally {
        this.routes.delete(input.sessionId)
      }
    }
    let released = false
    for (const candidate of Object.values(this.adapters)) {
      released = (await candidate.releaseAcquisition?.(input)) === true || released
    }
    return released
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    this.owner(input.sessionId).dispatch(input)

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.rewindSupport?.(sessionId) ?? {
      supported: false,
      reason: 'unsupported'
    }

  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    this.owner(input.sessionId).rewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    this.owner(input.sessionId).recoverRewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) => {
    const compact = this.owner(input.sessionId).compact
    if (!compact) {
      throw new Error('Compaction is unavailable for this provider.')
    }
    return compact(input)
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    this.owner(input.sessionId).cancelTurn(input)

  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = (input) => {
    const change = this.owner(input.sessionId).changeThreadGoal
    if (!change) {
      return Promise.resolve({ ok: false, rejected: 'Goals are unavailable for this provider.' })
    }
    return change(input)
  }

  supportsThreadGoal = (sessionId: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.supportsThreadGoal?.(sessionId) ?? false

  recordsContextUsage = (sessionId: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.recordsContextUsage?.(sessionId) ?? false

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => {
    const stop = this.owner(input.sessionId).stopBackgroundTasks
    return stop ? stop(input) : Promise.resolve({ cancelled: false })
  }

  backgroundTaskState: NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']> = (
    sessionId
  ) => this.liveOwnerOrNull(sessionId)?.backgroundTaskState?.(sessionId)

  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.readCommands?.(sessionId)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId).answerPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.owner(input.sessionId).setOption(input)

  awaitOptionWritable = (sessionId: string): Promise<void> =>
    this.liveOwnerOrNull(sessionId)?.awaitOptionWritable?.(sessionId) ?? Promise.resolve()

  readOptions = (input: { sessionId: string; fence: number }) => {
    const reader = this.owner(input.sessionId).readOptions
    if (!reader) {
      throw new Error(`structured session ${input.sessionId} does not report options`)
    }
    return reader(input)
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.owner(sessionId).readOptionRestoreFailures?.(sessionId) ?? []

  historyFilePath = (input: { identity: AgentSessionJournalIdentity }) =>
    this.requireAgent(input.identity).historyFilePath?.(input) ?? Promise.resolve(null)

  providerHistoryWindow = (input: {
    identity: AgentSessionJournalIdentity
    accountHome: AgentSessionAccountHome
  }) => this.requireAgent(input.identity).providerHistoryWindow?.(input) ?? Promise.resolve(null)

  closeSession = (sessionId: string): Promise<boolean> =>
    this.stopSession(sessionId, (adapter) => adapter.closeSession)

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.stopSession(sessionId, (adapter) => adapter.forceCloseSession ?? adapter.closeSession)

  disposeSession = (sessionId: string): Promise<boolean> =>
    this.stopSession(sessionId, (adapter) => adapter.disposeSession ?? adapter.closeSession)

  private async stopSession(
    sessionId: string,
    selectStop: (
      adapter: StructuredAgentSessionAdapter
    ) => NonNullable<StructuredAgentSessionAdapter['closeSession']> | undefined
  ): Promise<boolean> {
    const route = this.routes.get(sessionId)
    if (!route) {
      // No route is loss of contact, never proof of a stop. Answering `true` here would hand a
      // caller a receipt for a session this router never acted on — and the caller spends that
      // receipt by releasing the durable lease.
      return false
    }
    if (route.state === 'stopped') {
      return true
    }
    const stop = selectStop(route.adapter)
    const stopped = await stop?.call(route.adapter, sessionId)
    if (stopped === true) {
      route.state = 'stopped'
      return true
    }
    return false
  }

  async closeAll(): Promise<void> {
    if (this.allAdaptersClosed) {
      return
    }
    if (this.closePromise) {
      return this.closePromise
    }
    this.closePromise = (async () => {
      try {
        await this.closeAdapters()
        // Adapter shutdown only resolves once every child is PROVEN stopped, so each routed
        // session inherits that proof and keeps it per session. Clearing the map instead would
        // leave one boolean as the only surviving evidence, and an empty map cannot tell a
        // session this router stopped from one it never saw.
        for (const route of this.routes.values()) {
          route.state = 'stopped'
        }
        this.allAdaptersClosed = true
      } finally {
        this.closePromise = null
      }
    })()
    return this.closePromise
  }

  /** Drops a per-session stop receipt after the host releases its durable owner. */
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.routes.delete(sessionId)
  }

  private owner(sessionId: string): StructuredAgentSessionAdapter {
    const adapter = this.liveOwnerOrNull(sessionId)
    if (!adapter) {
      throw new Error(`no live structured adapter owns ${sessionId}`)
    }
    return adapter
  }

  private liveOwnerOrNull(sessionId: string): StructuredAgentSessionAdapter | null {
    const route = this.routes.get(sessionId)
    return route?.state === 'live' ? route.adapter : null
  }

  private requireAgent(identity: AgentSessionJournalIdentity): StructuredAgentSessionAdapter {
    const adapter = this.adapterForAgent(identity.agent)
    if (!adapter) {
      throw new Error(`structured sessions do not support ${identity.agent}`)
    }
    return adapter
  }

  private adapterForAgent(agent: string): StructuredAgentSessionAdapter | null {
    return agent === 'claude' || agent === 'codex' ? this.adapters[agent] : null
  }
}
