import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionAccountHome,
  AgentSessionExecutionLocation
} from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type {
  StructuredAgentRegistration,
  StructuredAgentRegistry
} from './structured-agent-registry'

type SessionRoute = {
  registration: StructuredAgentRegistration
  state: 'live' | 'stopped'
}

/** Routes each session to the adapter its agent is registered with. Adding an agent is one more
 *  registration; nothing here names one. */
export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly routes = new Map<string, SessionRoute>()
  private allAdaptersClosed = false
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly agents: StructuredAgentRegistry,
    private readonly closeAdapters: () => Promise<void>
  ) {}

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    const adapter = this.agents.registration(agent)?.adapter
    return adapter ? (adapter.supportsLocation?.(location) ?? false) : false
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    this.adapters().some((adapter) => adapter.supportsLocation?.(location) ?? false)

  /** Every adapter already gates its own shutdown, so the router only has to stop UNDOING that:
   *  a late acquire must not clear `allAdaptersClosed` and fan a session back out to closed
   *  adapters. Once closed, the router stays closed. */
  async acquire(input: Parameters<StructuredAgentSessionAdapter['acquire']>[0]) {
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    const registration = this.requireAgent(input.identity)
    const acquired = await registration.adapter.acquire(input)
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    this.routes.set(input.identity.sessionId, { registration, state: 'live' })
    return acquired
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    const route = this.routes.get(input.sessionId)
    if (route) {
      try {
        return (await route.registration.adapter.releaseAcquisition?.(input)) === true
      } finally {
        this.routes.delete(input.sessionId)
      }
    }
    let released = false
    for (const candidate of this.adapters()) {
      released = (await candidate.releaseAcquisition?.(input)) === true || released
    }
    return released
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    this.owner(input.sessionId).dispatch(input)

  /** The owner's declared rewind, narrowed by its adapter for this session; never widened. */
  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (
    sessionId,
    agent
  ) => {
    const owner = this.capabilityOwner(sessionId, agent)
    if (!owner?.definition.capabilities.rewind) {
      return { supported: false, reason: 'unsupported' }
    }
    return owner.adapter.rewindSupport?.(sessionId) ?? { supported: true }
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

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => {
    const stop = this.owner(input.sessionId).stopBackgroundTasks
    return stop ? stop(input) : Promise.resolve({ cancelled: false })
  }

  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) => this.liveOwnerOrNull(sessionId)?.backgroundTaskStops?.(sessionId)

  holdsDispatch = (sessionId: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.holdsDispatch?.(sessionId) ?? false

  stopEndsSession = (sessionId: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.stopEndsSession?.(sessionId) ?? false

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number) =>
    this.liveOwnerOrNull(sessionId)?.awaitStoppedRequestEnd?.(sessionId, stoppedAt)

  routePromptCancel: NonNullable<StructuredAgentSessionAdapter['routePromptCancel']> = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.routePromptCancel?.(input)

  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = async (input) =>
    this.owner(input.sessionId).dismissPrompt?.(input)

  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.readCommands?.(sessionId)

  atRestCommands: StructuredAgentSessionAtRestCommands = {
    read: (record) =>
      this.agents.registration(record.provider)?.adapter.atRestCommands?.read(record),
    onChange: (listener) => {
      const stops = this.adapters().flatMap((adapter) =>
        adapter.atRestCommands ? [adapter.atRestCommands.onChange(listener)] : []
      )
      return () => stops.forEach((stop) => stop())
    }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId).answerPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.owner(input.sessionId).setOption(input)

  awaitOptionWritable = (sessionId: string): Promise<void> =>
    this.liveOwnerOrNull(sessionId)?.awaitOptionWritable?.(sessionId) ?? Promise.resolve()
  awaitStarted = (sessionId: string): Promise<void | SubmissionRejectionFact> =>
    this.liveOwnerOrNull(sessionId)?.awaitStarted?.(sessionId) ?? Promise.resolve()

  readOptions = (input: { sessionId: string; fence: number }) => {
    const reader = this.owner(input.sessionId).readOptions
    if (!reader) {
      throw new Error(`structured session ${input.sessionId} does not report options`)
    }
    return reader(input)
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.owner(sessionId).readOptionRestoreFailures?.(sessionId) ?? []

  providerHistoryWindow = (input: {
    identity: AgentSessionJournalIdentity
    accountHome: AgentSessionAccountHome
  }) =>
    this.requireAgent(input.identity).adapter.providerHistoryWindow?.(input) ??
    Promise.resolve(null)

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
    const { adapter } = route.registration
    const stop = selectStop(adapter)
    const stopped = await stop?.call(adapter, sessionId)
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

  /** The live owner, or for a session at rest the agent it would start under. */
  private capabilityOwner(sessionId: string, agent?: string): StructuredAgentRegistration | null {
    const route = this.routes.get(sessionId)
    if (route?.state === 'live') {
      return route.registration
    }
    return agent ? this.agents.registration(agent) : null
  }

  private liveOwnerOrNull(sessionId: string): StructuredAgentSessionAdapter | null {
    const route = this.routes.get(sessionId)
    return route?.state === 'live' ? route.registration.adapter : null
  }

  private requireAgent(identity: AgentSessionJournalIdentity): StructuredAgentRegistration {
    const registration = this.agents.registration(identity.agent)
    if (!registration) {
      throw new Error(`structured sessions do not support ${identity.agent}`)
    }
    return registration
  }

  private adapters(): StructuredAgentSessionAdapter[] {
    return this.agents.registrations().map((registration) => registration.adapter)
  }
}
