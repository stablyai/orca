import { randomUUID } from 'node:crypto'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { HarnessConversationDriverFactory } from './driver'
import { createMachineStructuredSessionDriverSink } from './machine-structured-session-driver-sink'
import {
  decodeAnswers,
  lifecycleIdentity,
  machineAgent,
  type MachineStructuredSession,
  optionRecord,
  optionValue,
  processIdentity,
  providerHandleLink,
  providerOptions,
  providerPrompt,
  providerSessionId,
  requiredEvents,
  waitForProcessExit
} from './machine-structured-session-values'

export type MachineStructuredSessionAdapterDeps = {
  createDriver: HarnessConversationDriverFactory
  resolveWorkspacePath: (identity: AgentSessionJournalIdentity) => Promise<string>
  resolveProviderEnvironment?: (
    identity: AgentSessionJournalIdentity
  ) => Promise<Record<string, string>>
  readProcessStartTime?: (pid: number) => Promise<number | null>
  onEvent?: (event: {
    type: 'ended'
    sessionId: string
    reason: string
    cause: 'unexpected-exit' | 'requested-close'
    fence: number
    acquisitionGeneration: string
  }) => void
  now?: () => number
}

export class MachineStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, MachineStructuredSession>()

  constructor(private readonly deps: MachineStructuredSessionAdapterDeps) {}

  supportsCreate = (_location: unknown, agent: string): boolean =>
    agent === 'claude' || agent === 'grok' || agent === 'omp' || agent === 'acp'

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const { identity } = input
    const agent = machineAgent(identity.agent)
    if (agent === 'codex') {
      throw new Error('Codex must use the app-server adapter')
    }
    await this.closeSession(identity.sessionId)

    const state = {
      processId: 0,
      providerSessionId: providerSessionId(identity),
      endedReason: null as string | null,
      context: null as AgentSessionContextSnapshot | null,
      configuration: null as StructuredProviderConfiguration | null,
      transcriptPath: null as string | null
    }
    const messages = new Map<string, AgentJournalMessageItem>()
    const prompts = new Map<string, { kind: 'approval' | 'question'; requestId: string }>()
    const sessionRef = { current: null as MachineStructuredSession | null }
    const sink = createMachineStructuredSessionDriverSink({
      identity,
      events: input.events,
      state,
      messages,
      prompts,
      sessionRef,
      onEnd: (reason) => {
        const session = sessionRef.current
        if (!session) {
          return
        }
        this.sessions.delete(identity.sessionId)
        this.deps.onEvent?.({
          type: 'ended',
          sessionId: identity.sessionId,
          reason,
          cause: session.requestedClose ? 'requested-close' : 'unexpected-exit',
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration
        })
      }
    })
    const newProviderSessionId =
      agent === 'claude' && !state.providerSessionId ? randomUUID() : undefined
    const driver = await this.deps.createDriver({
      conversationId: identity.sessionId,
      agent,
      cwd: await this.deps.resolveWorkspacePath(identity),
      providerSessionId: state.providerSessionId,
      ...(newProviderSessionId ? { newProviderSessionId } : {}),
      forkFromProviderSessionId: null,
      spawnToken: input.spawnToken,
      providerEnvironment: await this.deps.resolveProviderEnvironment?.(identity),
      sink
    })
    try {
      await driver.ready?.()
      const sessionProviderId = state.providerSessionId ?? newProviderSessionId
      if (!state.processId || !sessionProviderId || state.endedReason) {
        throw new Error(state.endedReason ?? 'provider acquisition did not publish its identity')
      }
      const process = await processIdentity(
        identity.hostId,
        state.processId,
        input.spawnToken,
        this.deps.readProcessStartTime
      )
      const acquisitionGeneration = randomUUID()
      const session: MachineStructuredSession = {
        agent,
        driver,
        events: requiredEvents(input.events),
        fence: input.fence,
        acquisitionGeneration,
        process,
        providerSessionId: sessionProviderId,
        messages,
        prompts,
        activeTurn: null,
        requestedClose: false,
        context: state.context,
        configuration: state.configuration,
        transcriptPath: state.transcriptPath
      }
      sessionRef.current = session
      this.sessions.set(identity.sessionId, session)
      return {
        process,
        link: providerHandleLink(identity, agent, sessionProviderId, input.fence, this.now()),
        acquisitionGeneration
      }
    } catch (error) {
      await driver.close().catch(() => undefined)
      throw error
    }
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.session(input.sessionId)
    if (session.activeTurn) {
      return { state: 'rejected', reason: 'conversation_busy' }
    }
    const turnId = input.clientMessageId
    const identity = lifecycleIdentity(session.agent, input.sessionId, turnId)
    session.activeTurn = turnId
    this.append(session, identity, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId, state: 'running' }
    })
    const { text, imagePaths } = providerPrompt(input.body)
    void session.driver.send(text, imagePaths).then(
      () => this.completeTurn(input.sessionId, turnId, 'completed'),
      (error) =>
        this.completeTurn(
          input.sessionId,
          turnId,
          error instanceof Error && error.message === 'turn_interrupted' ? 'interrupted' : 'failed',
          error
        )
    )
    return { state: 'accepted', providerIdentity: identity }
  }

  async cancelTurn(input: { sessionId: string; turnId: string }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId)
    if (session.activeTurn !== input.turnId) {
      return { cancelled: false }
    }
    await session.driver.interrupt()
    return { cancelled: true }
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
  }): Promise<void> {
    const session = this.session(input.sessionId)
    const prompt = session.prompts.get(input.itemId)
    if (!prompt || prompt.kind !== input.kind) {
      throw new Error('provider prompt is no longer pending')
    }
    session.prompts.delete(input.itemId)
    if (prompt.kind === 'approval') {
      session.driver.answerPermission(prompt.requestId, input.optionId)
      return
    }
    session.driver.answerInput(prompt.requestId, decodeAnswers(input.optionId))
  }

  async setOption(input: { sessionId: string; key: string; value: string }) {
    const session = this.session(input.sessionId)
    if (!session.driver.setOption) {
      throw new Error('conversation_option_unsupported')
    }
    await session.driver.setOption(
      input.key,
      optionValue(session.configuration, input.key, input.value)
    )
    return optionRecord(session.configuration)
  }

  async readOptions(input: { sessionId: string }): Promise<AgentSessionOptionsResult> {
    const session = this.session(input.sessionId)
    return providerOptions(session.configuration)
  }

  historyFilePath = async ({ identity }: { identity: AgentSessionJournalIdentity }) =>
    this.sessions.get(identity.sessionId)?.transcriptPath ?? null

  readContext(sessionId: string): AgentSessionContextSnapshot | null {
    return this.sessions.get(sessionId)?.context ?? null
  }

  readConfiguration(sessionId: string): StructuredProviderConfiguration | null {
    return this.sessions.get(sessionId)?.configuration ?? null
  }

  closeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  releaseAcquisition = ({ sessionId }: { sessionId: string }): Promise<boolean> =>
    this.close(sessionId)

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)))
  }

  private async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    session.requestedClose = true
    await session.driver.close()
    const closed = await waitForProcessExit(session.process, this.deps.readProcessStartTime)
    if (closed) {
      this.sessions.delete(sessionId)
    }
    return closed
  }

  private completeTurn(
    sessionId: string,
    turnId: string,
    outcome: 'completed' | 'failed' | 'interrupted',
    error?: unknown
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.activeTurn !== turnId) {
      return
    }
    session.activeTurn = null
    this.append(session, lifecycleIdentity(session.agent, sessionId, turnId), {
      kind: 'status',
      text:
        outcome === 'completed'
          ? 'Completed'
          : outcome === 'interrupted'
            ? 'Interrupted'
            : `Failed: ${error instanceof Error ? error.message : String(error)}`,
      turnLifecycle: { turnId, state: 'completed', outcome }
    })
  }

  private append(
    session: MachineStructuredSession,
    identity: AgentJournalItemIdentity,
    body: Parameters<StructuredAgentSessionEventSink['appendItem']>[1]
  ): void {
    session.events.appendItem(identity, body, { lifecycle: body.kind === 'status' })
    session.events.publish({ lifecycle: body.kind === 'status' })
  }

  private session(sessionId: string): MachineStructuredSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live provider for session ${sessionId}`)
    }
    return session
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
