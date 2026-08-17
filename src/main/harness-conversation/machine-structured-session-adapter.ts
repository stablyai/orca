import { randomUUID } from 'node:crypto'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { HarnessConversationDriverFactory } from './driver'
import { createMachineStructuredSessionDriverSink } from './machine-structured-session-driver-sink'
import {
  decodeAnswers,
  lifecycleIdentity,
  machineAgent,
  type MachineStructuredSession,
  type MachineStructuredMessage,
  processIdentity,
  providerHandleLink,
  providerPrompt,
  providerSessionId,
  requiredEvents
} from './machine-structured-session-values'
import { MachineStructuredSessionAdapterState } from './machine-structured-session-adapter-state'

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
  canStartEmptyClaudeSession?: (sessionId: string) => Promise<boolean>
}

export class MachineStructuredSessionAdapter
  extends MachineStructuredSessionAdapterState
  implements StructuredAgentSessionAdapter
{
  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const { identity } = input
    const agent = machineAgent(identity.agent)
    if (agent === 'codex') {
      throw new Error('Codex must use the app-server adapter')
    }
    await this.closeSession(identity.sessionId)
    const previousId = providerSessionId(identity)
    const startEmpty =
      agent === 'openclaude' && (await this.deps.canStartEmptyClaudeSession?.(identity.sessionId))
    const state = {
      processId: 0,
      providerSessionId: startEmpty ? null : previousId,
      endedReason: null as string | null,
      context: null as AgentSessionContextSnapshot | null,
      configuration: null as StructuredProviderConfiguration | null,
      transcriptPath: null as string | null
    }
    const messages = new Map<string, MachineStructuredMessage>()
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
      (agent === 'claude' || agent === 'openclaude') && !state.providerSessionId
        ? (previousId ?? randomUUID())
        : undefined
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
      await this.readyDriver(driver, startEmpty ? input.options : undefined)
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
    let accepted = false
    let markAccepted = (): void => undefined
    const acceptance = new Promise<void>((resolve) => {
      markAccepted = () => {
        accepted = true
        resolve()
      }
    })
    const completion = session.driver.send(text, imagePaths, {
      clientMessageId: input.clientMessageId,
      accepted: markAccepted
    })
    void completion.then(
      () => this.completeTurn(input.sessionId, turnId, 'completed'),
      (error) =>
        this.completeTurn(
          input.sessionId,
          turnId,
          error instanceof Error && error.message === 'turn_interrupted' ? 'interrupted' : 'failed',
          error
        )
    )
    try {
      await Promise.race([acceptance, completion])
    } catch (error) {
      return { state: 'rejected', reason: error instanceof Error ? error.message : String(error) }
    }
    return accepted
      ? {
          state: 'accepted',
          providerIdentity: {
            provider: 'legacy',
            agent: session.agent,
            sessionId: input.sessionId,
            recordId: `user:${input.clientMessageId}`,
            turn: { turnId, root: true }
          }
        }
      : { state: 'unknown', reason: 'provider completed without accepting the submission' }
  }

  async steer(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    turnId: string
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.session(input.sessionId)
    if (session.activeTurn !== input.turnId || !session.driver.steer) {
      return { state: 'rejected', reason: 'conversation_steer_unsupported' }
    }
    const identity: AgentJournalItemIdentity = {
      provider: 'legacy',
      agent: session.agent,
      sessionId: input.sessionId,
      recordId: `user:${input.clientMessageId}`
    }
    const { text, imagePaths } = providerPrompt(input.body)
    let outcome: AgentSessionDispatchOutcome | null = null
    try {
      await session.driver.steer(text, imagePaths, input.clientMessageId, async (accepted) => {
        if (accepted.placement === 'next') {
          this.completeTurn(input.sessionId, input.turnId, 'completed')
          session.activeTurn = input.clientMessageId
        }
        identity.turn = {
          turnId: session.activeTurn!,
          ...(accepted.placement === 'next' ? { root: true as const } : {})
        }
        this.append(session, identity, input.body)
        if (accepted.placement === 'next') {
          this.append(
            session,
            lifecycleIdentity(session.agent, input.sessionId, input.clientMessageId),
            {
              kind: 'status',
              text: 'Working',
              turnLifecycle: { turnId: input.clientMessageId, state: 'running' }
            }
          )
          void accepted.completion.then(
            () => this.completeTurn(input.sessionId, input.clientMessageId, 'completed'),
            (error) =>
              this.completeTurn(
                input.sessionId,
                input.clientMessageId,
                error instanceof Error && error.message === 'turn_interrupted'
                  ? 'interrupted'
                  : 'failed',
                error
              )
          )
        }
        outcome = { state: 'accepted', providerIdentity: identity }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return /(?:unsupported|rejected|not_working|busy|turn_mismatch)$/.test(reason)
        ? { state: 'rejected', reason }
        : { state: 'unknown', reason }
    }
    return outcome ?? { state: 'unknown', reason: 'provider did not confirm steering' }
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
}
