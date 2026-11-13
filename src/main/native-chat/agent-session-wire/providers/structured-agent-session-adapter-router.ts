import type { StructuredAgentSessionAtRestCommands } from '../options/structured-agent-session-at-rest-commands'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter as Adapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionAcquisitionReceipt } from '../startup/structured-agent-session-startup-attempt-contract'
import type {
  StructuredAgentRegistration,
  StructuredAgentRegistry
} from './structured-agent-registry'

import {
  acquireSessionRoute,
  releaseSessionRoute,
  stopSessionRoute,
  type SessionRoute
} from './structured-agent-session-acquisition-route'

export class StructuredAgentSessionAdapterRouter implements Adapter {
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

  /** Closure is permanent; late acquisition must never reopen routing to closed adapters. */
  async acquire(input: Parameters<Adapter['acquire']>[0]) {
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    const registration = this.requireAgent(input.identity)
    return acquireSessionRoute(input, registration, this.routes, () => this.allAdaptersClosed)
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return releaseSessionRoute(input, this.routes, () => this.adapters())
  }

  open: Adapter['open'] = (input) => this.owner(input.sessionId).open(input)

  dispatch: Adapter['dispatch'] = (input) => this.owner(input.sessionId).dispatch(input)

  permissionModeRequiresAcquisition = (
    sessionId: string,
    mode: AgentChatPermissionChoice
  ): boolean | undefined =>
    this.liveOwnerOrNull(sessionId)?.permissionModeRequiresAcquisition?.(sessionId, mode)

  settlePermissionTransition: NonNullable<Adapter['settlePermissionTransition']> = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.settlePermissionTransition?.(input) ??
    Promise.resolve(true)

  /** Session support may narrow the owner’s declared rewind, never widen it. */
  rewindSupport: NonNullable<Adapter['rewindSupport']> = (sessionId, agent) => {
    const owner = this.capabilityOwner(sessionId, agent)
    if (!owner?.definition.capabilities.rewind) {
      return { supported: false, reason: 'unsupported' }
    }
    return owner.adapter.rewindSupport?.(sessionId) ?? { supported: true }
  }

  prepareRewind: NonNullable<Adapter['prepareRewind']> = (input) =>
    this.owner(input.sessionId).prepareRewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  rewind: NonNullable<Adapter['rewind']> = (input) =>
    this.owner(input.sessionId).rewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  forkForRewind: NonNullable<Adapter['forkForRewind']> = (input) =>
    this.capabilityOwner(input.record.sessionId, input.record.provider)?.adapter.forkForRewind?.(
      input
    ) ?? Promise.resolve({ ok: false, reason: 'unsupported' })

  /** Routed by the record's agent so a chat at rest still reaches its adapter. */
  nameProviderConversation: NonNullable<Adapter['nameProviderConversation']> = (input) =>
    this.capabilityOwner(
      input.record.sessionId,
      input.record.provider
    )?.adapter.nameProviderConversation?.(input)

  stopProviderNaming = (): void => {
    for (const adapter of this.adapters()) {
      adapter.stopProviderNaming?.()
    }
  }

  captureConversationTitleOwner: NonNullable<Adapter['captureConversationTitleOwner']> = (record) =>
    this.liveOwnerOrNull(record.sessionId)?.captureConversationTitleOwner?.(record) ?? null

  renameProviderSession: NonNullable<Adapter['renameProviderSession']> = (input) =>
    this.capabilityOwner(
      input.record.sessionId,
      input.record.provider
    )?.adapter.renameProviderSession?.(input) ?? Promise.resolve()

  recoverRewind: NonNullable<Adapter['recoverRewind']> = (input) =>
    this.owner(input.sessionId).recoverRewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  compact: NonNullable<Adapter['compact']> = (input) => {
    const compact = this.owner(input.sessionId).compact
    if (!compact) {
      throw new Error('Compaction is unavailable for this provider.')
    }
    return compact(input)
  }

  cancelTurn: Adapter['cancelTurn'] = (input) => this.owner(input.sessionId).cancelTurn(input)

  changeThreadGoal: NonNullable<Adapter['changeThreadGoal']> = (input) => {
    const change = this.owner(input.sessionId).changeThreadGoal
    if (!change) {
      return Promise.resolve({ ok: false, rejected: 'Goals are unavailable for this provider.' })
    }
    return change(input)
  }

  stopBackgroundTasks: NonNullable<Adapter['stopBackgroundTasks']> = (input) => {
    const stop = this.owner(input.sessionId).stopBackgroundTasks
    return stop ? stop(input) : Promise.resolve({ cancelled: false })
  }

  backgroundTaskStops: NonNullable<Adapter['backgroundTaskStops']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.backgroundTaskStops?.(sessionId)

  holdsDispatch = (sessionId: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.holdsDispatch?.(sessionId) ?? false

  confirmIdle = (id: string) => this.liveOwnerOrNull(id)?.confirmIdle?.(id)

  liveTurnId = (sessionId: string): string | null | undefined =>
    this.liveOwnerOrNull(sessionId)?.liveTurnId?.(sessionId)

  requiresModelTransitionRestart: NonNullable<Adapter['requiresModelTransitionRestart']> = (
    input
  ) => this.liveOwnerOrNull(input.sessionId)?.requiresModelTransitionRestart?.(input) ?? false

  capturePendingOutput: Adapter['capturePendingOutput'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.capturePendingOutput?.(input)

  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    this.liveOwnerOrNull(sessionId)?.heldSends?.(sessionId)

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.holdsLiveProviderProcess?.(sessionId, acquisitionGeneration) ??
    false

  // A start's owner outlives its route: exit acknowledgment may drop the route while the owner
  // still reads its ending, so both calls reach the adapters by exact generation, not by route.
  startupEnding = (sessionId: string, acquisitionGeneration: string) =>
    this.adapters()
      .map((adapter) => adapter.startupEnding?.(sessionId, acquisitionGeneration))
      .find((ending) => ending !== undefined)

  retireStartup = (sessionId: string, acquisitionGeneration: string): void =>
    this.adapters().forEach((adapter) => adapter.retireStartup?.(sessionId, acquisitionGeneration))

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number) =>
    this.liveOwnerOrNull(sessionId)?.awaitStoppedRequestEnd?.(sessionId, stoppedAt)

  routePromptCancel: NonNullable<Adapter['routePromptCancel']> = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.routePromptCancel?.(input)

  dismissPrompt: NonNullable<Adapter['dismissPrompt']> = async (input) =>
    this.owner(input.sessionId).dismissPrompt?.(input)

  readCommands: NonNullable<Adapter['readCommands']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.readCommands?.(sessionId)

  atRestCommands: StructuredAgentSessionAtRestCommands = {
    read: (record) =>
      this.agents.registration(record.provider)?.adapter.atRestCommands?.read(record),
    snapshot: (record) =>
      this.agents.registration(record.provider)?.adapter.atRestCommands?.snapshot?.(record) ?? {
        commandsPending: false
      },
    settled: async (record, budgetMs, independent) => {
      const source = this.agents.registration(record.provider)?.adapter.atRestCommands
      return source?.settled ? source.settled(record, budgetMs, independent) : source?.read(record)
    },
    onChange: (listener) => {
      const stops = this.adapters().flatMap((adapter) =>
        adapter.atRestCommands ? [adapter.atRestCommands.onChange(listener)] : []
      )
      return () => stops.forEach((stop) => stop())
    }
  }

  answerPrompt: Adapter['answerPrompt'] = (input) => this.owner(input.sessionId).answerPrompt(input)

  setOption: Adapter['setOption'] = (input) => this.owner(input.sessionId).setOption(input)

  canSetOptionWhileIdle: Adapter['canSetOptionWhileIdle'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.canSetOptionWhileIdle?.(input) === true
  readAppliedInputOptions: Adapter['readAppliedInputOptions'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.readAppliedInputOptions?.(input) ?? null

  projectOptions: Adapter['projectOptions'] = (sessionId, options) =>
    this.liveOwnerOrNull(sessionId)?.projectOptions?.(sessionId, options)

  readOptions = (input: { sessionId: string; fence: number }) => {
    const reader = this.owner(input.sessionId).readOptions
    if (!reader) {
      throw new Error(`structured session ${input.sessionId} does not report options`)
    }
    return reader(input)
  }

  generateText: NonNullable<Adapter['generateText']> = (input) => {
    const { adapter } = this.requireAgent(input)
    if (!adapter.generateText) {
      return Promise.reject(new Error(`${input.agent} cannot run an independent text task`))
    }
    return adapter.generateText(input)
  }

  copyConversation: NonNullable<Adapter['copyConversation']> = (input) => {
    const { adapter } = this.requireAgent(input.identity)
    if (!adapter.copyConversation) {
      return Promise.reject(new Error(`${input.identity.agent} cannot copy a conversation`))
    }
    return adapter.copyConversation(input)
  }

  closeSession: NonNullable<Adapter['closeSession']> = (...args) =>
    this.stopSession(args[0], (adapter) => adapter.closeSession?.(...args))

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.stopSession(sessionId, (adapter) =>
      (adapter.forceCloseSession ?? adapter.closeSession)?.call(adapter, sessionId)
    )

  disposeSession: NonNullable<Adapter['disposeSession']> = (...args) =>
    this.stopSession(args[0], (adapter) =>
      (adapter.disposeSession ?? adapter.closeSession)?.call(adapter, ...args)
    )

  private async stopSession(
    sessionId: string,
    stop: (adapter: Adapter) => Promise<boolean> | undefined
  ): Promise<boolean> {
    const route = this.routes.get(sessionId)
    if (!route) {
      // Missing routes prove no stop; claiming success would incorrectly release a durable lease.
      return false
    }
    if (route.state === 'acquiring') {
      return this.releaseAcquisition({ sessionId })
    }
    return stopSessionRoute(route, () => stop(route.registration.adapter))
  }

  hasOwnedAcquisition = (sessionId: string): boolean => {
    const route = this.routes.get(sessionId)
    return (
      ((route?.state === 'stopped' || route?.state === 'kill-delivered') && !!route.acquisition) ||
      route?.registration.adapter.hasOwnedAcquisition?.(sessionId) === true
    )
  }

  stoppedAcquisition = (
    sessionId: string
  ): StructuredAgentSessionAcquisitionReceipt | undefined => {
    const route = this.routes.get(sessionId)
    return route?.state === 'stopped' || route?.state === 'kill-delivered'
      ? route.acquisition
      : undefined
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
        // Preserve per-session shutdown proof; an empty map cannot distinguish stopped from unseen sessions.
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

  /** Retain stop receipts until durable ownership is released. */
  acknowledgeSessionRelease = (
    sessionId: string,
    acquisition?: StructuredAgentSessionAcquisitionReceipt
  ): void => {
    if (!acquisition || this.stoppedAcquisition(sessionId) === acquisition) {
      this.routes
        .get(sessionId)
        ?.registration.adapter.acknowledgeSessionRelease?.(sessionId, acquisition)
      this.routes.delete(sessionId)
    }
  }

  private owner(sessionId: string): Adapter {
    const adapter = this.liveOwnerOrNull(sessionId)
    if (!adapter) {
      throw new Error(`no live structured adapter owns ${sessionId}`)
    }
    return adapter
  }

  private capabilityOwner(sessionId: string, agent?: string): StructuredAgentRegistration | null {
    const route = this.routes.get(sessionId)
    if (route?.state === 'live') {
      return route.registration
    }
    return agent ? this.agents.registration(agent) : null
  }

  private liveOwnerOrNull(sessionId: string): Adapter | null {
    const route = this.routes.get(sessionId)
    return route?.state === 'live' ? route.registration.adapter : null
  }

  private requireAgent(
    identity: Pick<AgentSessionJournalIdentity, 'agent'>
  ): StructuredAgentRegistration {
    const registration = this.agents.registration(identity.agent)
    if (!registration) {
      throw new Error(`structured sessions do not support ${identity.agent}`)
    }
    return registration
  }

  private adapters(): Adapter[] {
    return this.agents.registrations().map((registration) => registration.adapter)
  }
}
