// A structured chat over the Muse Session Protocol: one `muse serve` child per
// session, journaled through the host sink. Steering injects into the running
// turn; Stop ends the child and the next send resumes the MSP session on a new
// child. Approvals and questions arrive as server requests and journal as
// pending rows until answered.

import { randomUUID } from 'node:crypto'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { initializeMspClient, spawnMspClient } from './msp-client'
import { openMspSession } from './msp-session-open'
import { MspStructuredSession } from './msp-session'
import { MspJournalTranslator, mspItemIdentity } from './msp-journal-translation'
import {
  answerMspPrompt,
  dismissMspPrompt,
  journalMspApproval,
  journalMspQuestion
} from './muse-structured-session-prompts'
import {
  museCurrentOptions,
  museOptionsListing,
  setMuseSessionOption
} from './muse-structured-session-options'
import { dispatchMuseTurn } from './muse-structured-dispatch'
import {
  acknowledgeMspRelease,
  cancelMspTurn,
  closeAllMspSessions,
  handleMspExit,
  heldMspSends,
  holdsMspDispatch,
  holdsMspProcess,
  stopMspSession,
  type MspLifecycleContext
} from './muse-structured-session-lifecycle'
import type { MspLiveSession } from './muse-structured-live-session'

export type MuseStructuredSessionAdapterDeps = {
  resolveLaunch: (request: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
  }) => Promise<{
    command: string
    args: readonly string[]
    cwd: string
    env: Record<string, string>
    resumeSessionId?: string | null
  }>
  logger: StructuredAgentSessionLogger
  readProcessStartTime?: (pid: number) => Promise<number | null>
  onLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  onDispatchSettledLate?: (
    settlement: { sessionId: string; clientMessageId: string } & (
      | { providerIdentity: AgentJournalItemIdentity }
      | ({ state: 'rejected' } & AgentJournalDispatchRejection)
      | { state: 'unknown'; reason: string }
    )
  ) => void
  now?: () => number
}

export class MuseStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, MspLiveSession>()

  constructor(private readonly deps: MuseStructuredSessionAdapterDeps) {}

  supportsLocation = (): boolean => true

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const sink = input.events
    if (!sink) {
      throw new AgentSessionPreSpawnError(new Error('Muse chats need a journal sink'))
    }
    await this.stopSession(sessionId)
    const generation = randomUUID()
    const launch = await this.deps.resolveLaunch({
      identity: input.identity,
      spawnToken: input.spawnToken
    })
    const client = spawnMspClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env
    })
    try {
      await initializeMspClient(client, { name: 'orca', version: '0' })
      const startOptions = input.options ?? {}
      const opened = await openMspSession(client, {
        workspaceRoot: launch.cwd,
        resumeSessionId: launch.resumeSessionId ?? undefined,
        ...(typeof startOptions.model === 'string' && startOptions.model.length > 0
          ? { modelId: startOptions.model }
          : {}),
        ...(typeof startOptions.permissionProfile === 'string' &&
        startOptions.permissionProfile.length > 0
          ? { permissionProfile: startOptions.permissionProfile }
          : {})
      })
      const mspSessionId = opened.session.sessionId
      const translator = new MspJournalTranslator({ sink, sessionId, now: () => this.now() })
      const live: MspLiveSession = {
        sessionId,
        fence: input.fence,
        acquisitionGeneration: generation,
        client,
        msp: null as never,
        translator,
        sink,
        pid: client.pid,
        journalClosed: null,
        ended: false,
        closeRequested: false,
        turnId: null,
        pendingTurn: null,
        options: opened.session.modelId ? { model: opened.session.modelId } : {},
        onEvent: (event) => this.deps.onLifecycle(event),
        prompts: new Map()
      }
      const msp = new MspStructuredSession(mspSessionId, client, {
        onItemStarted: (event) => translator.itemStarted(event),
        onItemDelta: (event) => translator.itemDelta(event),
        onItemUpdated: (event) => translator.itemUpdated(event),
        onItemCompleted: (event) => translator.itemCompleted(event),
        onTurnStarted: () => {
          translator.openTurn(live.turnId ?? 'unknown', {
            requestedAt: live.pendingTurn?.requestedAt
          })
        },
        onTurnCompleted: (event) => {
          const pending = live.pendingTurn
          translator.closeTurn(event)
          live.turnId = null
          live.pendingTurn = null
          if (pending) {
            this.deps.onDispatchSettledLate?.({
              sessionId: live.sessionId,
              clientMessageId: pending.clientMessageId,
              providerIdentity: mspItemIdentity(live.sessionId, `turn:${event.turnId}`)
            })
          }
        }
      })
      msp.onApproval = (request) => journalMspApproval(live, request)
      msp.onQuestion = (request) => journalMspQuestion(live, request)
      live.msp = msp
      if (typeof startOptions.effort === 'string' && startOptions.effort.length > 0) {
        await msp.setReasoningEffort(startOptions.effort)
        live.options.effort = startOptions.effort
      }
      if (
        typeof startOptions.permissionProfile === 'string' &&
        startOptions.permissionProfile.length > 0
      ) {
        live.options.permissionProfile = startOptions.permissionProfile
      }
      client.exited.then(() => this.lifecycleContext().onExit(sessionId, generation, false))
      this.sessions.set(sessionId, live)
      const processStartTimeMs =
        client.pid === undefined
          ? null
          : ((await this.deps.readProcessStartTime?.(client.pid)) ?? null)
      return {
        process: {
          hostId: '',
          pid: client.pid ?? -1,
          processStartTimeMs,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `muse-${mspSessionId}`.slice(0, 128),
          handle: { transport: 'msp', agent: 'muse', nativeId: mspSessionId },
          origin: launch.resumeSessionId ? 'resumed' : 'created',
          mintedAtFence: input.fence,
          observedAt: this.now()
        },
        acquisitionGeneration: generation
      }
    } catch (error) {
      await client.close('SIGKILL').catch(() => undefined)
      throw error
    }
  }

  open: StructuredAgentSessionAdapter['open'] = async (input) => {
    const live = this.sessions.get(input.sessionId)
    if (
      live?.fence !== input.fence ||
      live?.acquisitionGeneration !== input.acquisitionGeneration ||
      live?.ended
    ) {
      throw new Error('Muse child changed before it opened')
    }
    if (live.journalClosed !== null) {
      throw new Error('Muse child journal closed before it opened')
    }
    return {
      reportedOptions: museCurrentOptions(live),
      catalogListing: museOptionsListing().catalogListing
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) =>
    dispatchMuseTurn(this.live(input.sessionId), {
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      requestedAt: input.requestedAt,
      body: input.body,
      executionOptions: input.executionOptions,
      signal: input.signal,
      onInputPreparation: input.onInputPreparation,
      beforeDispatch: input.beforeDispatch,
      now: () => this.now()
    })

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    cancelMspTurn(this.live(input.sessionId), input)

  stopEndsSession = (): boolean => true

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number): Promise<void> => {
    const live = this.sessions.get(sessionId)
    if (!live) {
      return
    }
    const deadline = stoppedAt + 5000
    while (live.msp.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    answerMspPrompt(this.live(input.sessionId), input)

  dismissPrompt: StructuredAgentSessionAdapter['dismissPrompt'] = async (input) => {
    const live = this.sessions.get(input.sessionId)
    if (!live) {
      await input.commit()
      return
    }
    return dismissMspPrompt(live, input)
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    return setMuseSessionOption(this.live(input.sessionId), input.key, input.value)
  }

  readOptions = async (input: {
    sessionId: string
    fence: number
  }): Promise<StructuredAgentSessionLiveOptions> => {
    const live = this.sessions.get(input.sessionId)
    void input.fence
    const listing = museOptionsListing()
    return {
      current: live ? museCurrentOptions(live) : {},
      models: listing.models,
      catalogListing: listing.catalogListing
    }
  }

  holdsDispatch = (sessionId: string): boolean =>
    holdsMspDispatch(this.lifecycleContext(), sessionId)

  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    heldMspSends(this.lifecycleContext(), sessionId)

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean =>
    holdsMspProcess(this.lifecycleContext(), sessionId, acquisitionGeneration)

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    stopMspSession(this.lifecycleContext(), input.sessionId)

  hasOwnedAcquisition = (sessionId: string): boolean => this.sessions.has(sessionId)

  closeSession = (sessionId: string): Promise<boolean> =>
    stopMspSession(this.lifecycleContext(), sessionId)

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    stopMspSession(this.lifecycleContext(), sessionId, 'SIGKILL')

  disposeSession = (sessionId: string): Promise<boolean> =>
    stopMspSession(this.lifecycleContext(), sessionId)

  acknowledgeSessionRelease = (sessionId: string): void => {
    acknowledgeMspRelease(this.lifecycleContext(), sessionId)
  }

  private lifecycleContext(): MspLifecycleContext {
    return {
      sessions: this.sessions,
      onExit: (sessionId, generation, requested) =>
        handleMspExit(this.lifecycleContext(), sessionId, generation, requested)
    }
  }

  private live(sessionId: string): MspLiveSession {
    const live = this.sessions.get(sessionId)
    if (!live || live.ended || live.journalClosed !== null) {
      throw new Error(`no live Muse child owns ${sessionId}`)
    }
    return live
  }

  private stopSession(sessionId: string, signal?: NodeJS.Signals): Promise<boolean> {
    return stopMspSession(this.lifecycleContext(), sessionId, signal)
  }

  async closeAll(): Promise<void> {
    await closeAllMspSessions(this.lifecycleContext())
  }
}
