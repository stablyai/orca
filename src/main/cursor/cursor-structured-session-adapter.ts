import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../shared/agent-session-record'
import { readCursorSessionOptions } from './cursor-structured-session-options'
import type { CursorSdkConnection } from './cursor-sdk-connection'
import { openCursorSdkConnection } from './cursor-sdk-connection'
import {
  cursorModelSelection,
  cursorSelectedContextWindowTokens,
  emptyCursorModelListCache,
  refreshCursorModelList
} from './cursor-model-catalog'
import type { CursorSdkListedModel } from './cursor-sdk-protocol'
import { supportsCursorStructuredLocation } from './cursor-structured-location-support'
import { CursorJournalTranslator, type CursorTurn } from './cursor-structured-journal'
import {
  applyCursorSidecarEvent,
  beginCursorRun,
  closeCursorSession,
  cursorAuthFailure,
  cursorMessageImages,
  cursorMessageText,
  cursorProviderLink,
  enqueueCursorDispatch,
  steerCursorRun,
  waitForCursorStart,
  type CursorLiveSession
} from './cursor-structured-session-live'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  AgentSessionPromptUnavailableError,
  type AgentSessionAcquisition,
  type AgentSessionCancelOutcome,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

export type CursorStructuredSessionAdapterDeps = {
  hostId: string
  stateDirectory: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveApiKey?: () => string | undefined
  resolveToolGate?: () => { sandbox: boolean; autoReview: boolean }
  openConnection?: (input: { apiKey?: string }) => CursorSdkConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  listModels?: (apiKey: string | undefined) => Promise<CursorSdkListedModel[]>
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
}

export class CursorStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CursorLiveSession>()
  private readonly modelList = emptyCursorModelListCache()

  constructor(private readonly deps: CursorStructuredSessionAdapterDeps) {}

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsCursorStructuredLocation(location)

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    agent === 'cursor' && this.supportsLocation(location)

  stopEndsSession = (): boolean => false

  holdsDispatch = (sessionId: string): boolean => this.sessions.get(sessionId)?.runInFlight === true

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const cwd = await this.deps.resolveWorkspacePath(input.identity.workspaceId)
    const apiKey = this.deps.resolveApiKey?.()?.trim() || undefined
    const gate = this.deps.resolveToolGate?.() ?? { sandbox: false, autoReview: false }
    await mkdir(join(this.deps.stateDirectory, 'cursor-sdk-agents'), { recursive: true })
    const connection = await (this.deps.openConnection ?? openCursorSdkConnection)({ apiKey })
    if (!connection.pid) {
      await connection.close()
      throw new AgentSessionPreSpawnError(new Error('Cursor sidecar did not start'))
    }
    const processIdentity: AgentSessionProcessIdentity = {
      hostId: this.deps.hostId,
      pid: connection.pid,
      processStartTimeMs: await (this.deps.readProcessStartTime ?? readProcessStartTimeMs)(
        connection.pid
      ),
      spawnToken: input.spawnToken
    }
    await input.onSpawned?.(processIdentity)
    const options = { ...input.options }
    const mode = options.conversationMode === 'plan' ? 'plan' : 'agent'
    const translator = new CursorJournalTranslator(input.identity.sessionId, input.events)
    const session: CursorLiveSession = {
      connection,
      agentId: '',
      fence: input.fence,
      spawnToken: input.spawnToken,
      acquisitionGeneration: `cursor-${input.spawnToken}-${Date.now()}`,
      options,
      mode,
      cwd,
      translator,
      turn: null,
      runInFlight: false,
      resolveRun: null,
      runSettled: Promise.resolve(),
      steerWait: null,
      steerWaitId: null,
      nextSteerId: 0,
      started: false,
      closed: false
    }
    this.sessions.set(input.identity.sessionId, session)
    connection.onEvent((event) =>
      applyCursorSidecarEvent(input.identity.sessionId, session, event, this.deps.onEvent)
    )
    const handle = input.identity.providerHandle
    const resumeAgentId = handle?.agent === 'cursor' ? handle.nativeId : undefined
    const startedPromise = waitForCursorStart(session, input.signal)
    connection.send({
      type: 'start',
      cwd,
      storeDir: join(this.deps.stateDirectory, 'cursor-sdk-agents'),
      ...(apiKey ? { apiKey } : {}),
      ...(resumeAgentId ? { agentId: resumeAgentId } : {}),
      model: cursorModelSelection(options, this.modelList.models),
      mode,
      sandbox: gate.sandbox,
      autoReview: gate.autoReview
    })
    const started = await startedPromise.catch(async (error: unknown) => {
      this.sessions.delete(input.identity.sessionId)
      await connection.close({ force: true })
      throw error
    })
    if (input.signal?.aborted) {
      this.sessions.delete(input.identity.sessionId)
      await connection.close({ force: true })
      throw new Error('Cursor chat was closed while starting')
    }
    if (started.type !== 'ready') {
      this.sessions.delete(input.identity.sessionId)
      await connection.close()
      const message = started.type === 'startupError' ? started.message : 'Cursor sidecar exited'
      throw cursorAuthFailure(message, started.type === 'startupError' ? started.code : undefined)
        ? new AgentSessionAcquisitionRefusal(message, 'notSignedIn')
        : new AgentSessionAcquisitionRefusal(message)
    }
    session.agentId = started.agentId
    return {
      process: processIdentity,
      link: cursorProviderLink(started.agentId, input.fence, resumeAgentId ? 'resumed' : 'created'),
      acquisitionGeneration: session.acquisitionGeneration
    }
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.closed) {
      return { state: 'unknown', reason: 'Cursor chat is not running' }
    }
    return enqueueCursorDispatch(session, () => this.dispatchTurn(input, session))
  }

  private async dispatchTurn(
    input: {
      sessionId: string
      clientMessageId: string
      body: AgentJournalMessageItem
      fence: number
      requestedAt?: number
    },
    session: CursorLiveSession
  ): Promise<AgentSessionDispatchOutcome> {
    if (session.closed) {
      return { state: 'unknown', reason: 'Cursor chat is not running' }
    }
    const text = cursorMessageText(input.body)
    if (session.runInFlight) {
      const steered = await steerCursorRun(session, text)
      if (steered === 'complete_delivered' && session.turn) {
        return { state: 'accepted', providerIdentity: null }
      }
      await session.runSettled
    }
    // Read before the turn opens: a failed read must not leave a run that never settles.
    const images = await cursorMessageImages(input.body)
    const turn: CursorTurn = {
      sessionId: input.sessionId,
      turnId: input.clientMessageId,
      startedAt: Date.now(),
      ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt })
    }
    session.turn = turn
    session.translator.openTurn(turn)
    await refreshCursorModelList(this.modelList, this.deps)
    session.translator.setContextWindowTokens(
      cursorSelectedContextWindowTokens(session.options, this.modelList.models)
    )
    beginCursorRun(session)
    session.connection.send({
      type: 'send',
      text,
      ...images,
      model: cursorModelSelection(session.options, this.modelList.models),
      mode: session.mode
    })
    return { state: 'accepted', providerIdentity: null }
  }

  async cancelTurn(input: { sessionId: string }): Promise<AgentSessionCancelOutcome> {
    const session = this.sessions.get(input.sessionId)
    if (!session?.runInFlight) {
      return { cancelled: false }
    }
    session.connection.send({ type: 'cancel' })
    return { cancelled: true }
  }

  answerPrompt(input: { itemId: string }): Promise<void> {
    throw new AgentSessionPromptUnavailableError(input.itemId)
  }

  async setOption(input: StructuredAgentSessionSetOptionInput): Promise<Record<string, string>> {
    const session = this.requireSession(input.sessionId)
    if (input.key === 'conversationMode') {
      session.mode = input.value === 'plan' ? 'plan' : 'agent'
    }
    session.options = { ...session.options, [input.key]: input.value }
    session.translator.setContextWindowTokens(
      cursorSelectedContextWindowTokens(session.options, this.modelList.models)
    )
    return session.options
  }

  readOptions = (input: { sessionId: string }) =>
    readCursorSessionOptions({
      session: this.sessions.get(input.sessionId),
      modelList: this.modelList,
      refresh: () => refreshCursorModelList(this.modelList, this.deps)
    })

  awaitStarted = (): Promise<void> => Promise.resolve()

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.stop(input.sessionId)
  }

  async closeSession(sessionId: string): Promise<boolean> {
    return this.stop(sessionId)
  }

  async forceCloseSession(sessionId: string): Promise<boolean> {
    return this.stop(sessionId)
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    return this.stop(sessionId)
  }

  acknowledgeSessionRelease(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stop(sessionId)))
  }

  private requireSession(sessionId: string): CursorLiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Cursor chat ${sessionId} is not running`)
    }
    return session
  }

  private async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    const proved = await closeCursorSession(session)
    this.sessions.delete(sessionId)
    return proved
  }
}
