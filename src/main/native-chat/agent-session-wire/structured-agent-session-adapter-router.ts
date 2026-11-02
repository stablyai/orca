import { normalizeConstruction } from './structured-agent-session-construction'
import { structuredAgentSessionAdapterCapabilities } from './structured-agent-session-adapter-capabilities'

import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-identity'

import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionAcquisitionReceipt } from './structured-agent-session-startup-attempt-contract'
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

export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly routes = new Map<string, SessionRoute>()
  private readonly capabilities = structuredAgentSessionAdapterCapabilities(
    () => this.agents,
    this.routes
  )
  private allAdaptersClosed = false
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly agents: StructuredAgentRegistry,
    private readonly closeAdapters: () => Promise<void>
  ) {}
  supportsCreate = this.capabilities.supportsCreate

  supportsLocation = this.capabilities.supportsLocation

  /** Closure is permanent; late acquisition must never reopen routing to closed adapters. */
  async acquire(input: Parameters<StructuredAgentSessionAdapter['acquire']>[0]) {
    if (this.allAdaptersClosed) {
      throw new Error('structured session adapter router is closed')
    }
    const registration = this.requireAgent(input.identity)
    return acquireSessionRoute(input, registration, this.routes, () => this.allAdaptersClosed)
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return releaseSessionRoute(input, this.routes, () => this.adapters())
  }

  open: StructuredAgentSessionAdapter['open'] = (input) =>
    this.owner(input.sessionId).open(input).then(normalizeConstruction)

  injectHistoricalContext: NonNullable<StructuredAgentSessionAdapter['injectHistoricalContext']> = (
    input
  ) =>
    this.owner(input.sessionId).injectHistoricalContext?.(input) ??
    Promise.resolve({ kind: 'unsupported' })
  historicalInputBytes: NonNullable<StructuredAgentSessionAdapter['historicalInputBytes']> = (
    input
  ) =>
    this.owner(input.sessionId).historicalInputBytes?.(input) ??
    Promise.resolve({
      bytes: Buffer.byteLength(JSON.stringify(input.body)),
      limit: 8 * 1024 * 1024
    })

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    this.owner(input.sessionId).dispatch(input)

  permissionModeRequiresAcquisition = (
    sessionId: string,
    mode: AgentChatPermissionChoice
  ): boolean | undefined =>
    this.liveOwnerOrNull(sessionId)?.permissionModeRequiresAcquisition?.(sessionId, mode)
  rewindSupport = this.capabilities.rewindSupport

  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    this.owner(input.sessionId).rewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })
  forkForRewind = this.capabilities.forkForRewind

  nameProviderConversation = this.capabilities.nameProviderConversation

  stopProviderNaming = this.capabilities.stopProviderNaming

  renameProviderSession = this.capabilities.renameProviderSession

  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    this.owner(input.sessionId).recoverRewind?.(input) ??
    Promise.resolve({ ok: false, reason: 'unsupported' })

  compactUsesPrompt = (sessionId: string) =>
    this.owner(sessionId).compactUsesPrompt?.(sessionId) ?? false

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

  liveTurnId = (sessionId: string): string | null | undefined =>
    this.liveOwnerOrNull(sessionId)?.liveTurnId?.(sessionId)

  requiresModelTransitionRestart: NonNullable<
    StructuredAgentSessionAdapter['requiresModelTransitionRestart']
  > = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.requiresModelTransitionRestart?.(input) ?? false

  capturePendingOutput: StructuredAgentSessionAdapter['capturePendingOutput'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.capturePendingOutput?.(input)

  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    this.liveOwnerOrNull(sessionId)?.heldSends?.(sessionId)

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean =>
    this.liveOwnerOrNull(sessionId)?.holdsLiveProviderProcess?.(sessionId, acquisitionGeneration) ??
    false

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number) =>
    this.liveOwnerOrNull(sessionId)?.awaitStoppedRequestEnd?.(sessionId, stoppedAt)

  routePromptCancel: NonNullable<StructuredAgentSessionAdapter['routePromptCancel']> = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.routePromptCancel?.(input)

  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = async (input) =>
    this.owner(input.sessionId).dismissPrompt?.(input)

  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.liveOwnerOrNull(sessionId)?.readCommands?.(sessionId)
  atRestCommands = this.capabilities.atRestCommands

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId).answerPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.owner(input.sessionId).setOption(input)

  canSetOptionWhileIdle: StructuredAgentSessionAdapter['canSetOptionWhileIdle'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.canSetOptionWhileIdle?.(input) === true
  readAppliedInputOptions: StructuredAgentSessionAdapter['readAppliedInputOptions'] = (input) =>
    this.liveOwnerOrNull(input.sessionId)?.readAppliedInputOptions?.(input) ?? null

  projectOptions: StructuredAgentSessionAdapter['projectOptions'] = (sessionId, options) =>
    this.liveOwnerOrNull(sessionId)?.projectOptions?.(sessionId, options)

  readOptions = (input: { sessionId: string; fence: number }) => {
    const reader = this.owner(input.sessionId).readOptions
    if (!reader) {
      throw new Error(`structured session ${input.sessionId} does not report options`)
    }
    return reader(input)
  }

  generateText: NonNullable<StructuredAgentSessionAdapter['generateText']> = (input) => {
    const { adapter } = this.requireAgent(input)
    if (!adapter.generateText) {
      return Promise.reject(new Error(`${input.agent} cannot run an independent text task`))
    }
    return adapter.generateText(input)
  }

  copyConversation: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = (input) => {
    const { adapter } = this.requireAgent(input.identity)
    if (!adapter.copyConversation) {
      return Promise.reject(new Error(`${input.identity.agent} cannot copy a conversation`))
    }
    return adapter.copyConversation(input)
  }

  closeSession: NonNullable<StructuredAgentSessionAdapter['closeSession']> = (
    sessionId,
    observeClose
  ) => this.stopSession(sessionId, (adapter) => adapter.closeSession?.(sessionId, observeClose))

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.stopSession(sessionId, (adapter) =>
      (adapter.forceCloseSession ?? adapter.closeSession)?.call(adapter, sessionId)
    )

  disposeSession: NonNullable<StructuredAgentSessionAdapter['disposeSession']> = (
    sessionId,
    observeClose
  ) =>
    this.stopSession(sessionId, (adapter) =>
      (adapter.disposeSession ?? adapter.closeSession)?.call(adapter, sessionId, observeClose)
    )

  private async stopSession(
    sessionId: string,
    stop: (adapter: StructuredAgentSessionAdapter) => Promise<boolean> | undefined
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

  private owner(sessionId: string): StructuredAgentSessionAdapter {
    const adapter = this.liveOwnerOrNull(sessionId)
    if (!adapter) {
      throw new Error(`no live structured adapter owns ${sessionId}`)
    }
    return adapter
  }

  private liveOwnerOrNull(sessionId: string): StructuredAgentSessionAdapter | null {
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

  private adapters(): StructuredAgentSessionAdapter[] {
    return this.agents.registrations().map((registration) => registration.adapter)
  }
}
