import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { MachineStructuredSessionAdapterDeps } from './machine-structured-session-adapter'
import type { HarnessConversationDriver } from './driver'
import {
  lifecycleIdentity,
  machineTurnScope,
  type MachineStructuredSession,
  providerOptions,
  optionRecord,
  optionValue,
  waitForProcessExit
} from './machine-structured-session-values'

export class MachineStructuredSessionAdapterState {
  protected readonly sessions = new Map<string, MachineStructuredSession>()

  constructor(protected readonly deps: MachineStructuredSessionAdapterDeps) {}

  protected async readyDriver(
    driver: HarnessConversationDriver,
    state: { configuration: StructuredProviderConfiguration | null },
    options?: Readonly<Record<string, string>>
  ): Promise<void> {
    await driver.ready?.()
    if (!options || Object.keys(options).length === 0) {
      return
    }
    if (!driver.setOption) {
      throw new Error('provider cannot restore session options')
    }
    const { model, ...rest } = options
    if (model !== undefined) {
      await driver.setOption('model', model)
    }
    for (const [key, value] of Object.entries(rest)) {
      await driver.setOption(key, optionValue(state.configuration, key, value))
    }
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    supportsCodexStructuredLocation(location) &&
    (agent === 'openclaude' || agent === 'grok' || agent === 'omp')

  async readOptions(input: { sessionId: string }): Promise<AgentSessionOptionsResult> {
    return providerOptions(this.session(input.sessionId).configuration)
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

  historyFilePath = async ({ identity }: { identity: AgentSessionJournalIdentity }) =>
    this.sessions.get(identity.sessionId)?.transcriptPath ?? null

  readSubagents = (sessionId: string) => this.sessions.get(sessionId)?.subagents ?? []

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

  protected completeTurn(
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
      turnLifecycle: {
        turnId,
        state: outcome === 'interrupted' ? 'interrupted' : 'completed',
        outcome:
          outcome === 'completed' ? 'success' : outcome === 'failed' ? 'failure' : 'cancellation'
      }
    })
  }

  protected append(
    session: MachineStructuredSession,
    identity: Extract<AgentJournalItemIdentity, { provider: 'legacy' }>,
    body: Parameters<StructuredAgentSessionEventSink['appendItem']>[1]
  ): void {
    session.events.appendItem(identity, body, {
      lifecycle: body.kind === 'status',
      turnScope: machineTurnScope(
        session.agent,
        identity.sessionId,
        body.kind === 'status' ? null : (identity.turn?.turnId ?? session.activeTurn)
      )
    })
    session.events.publish({ lifecycle: body.kind === 'status' })
  }

  protected session(sessionId: string): MachineStructuredSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live provider for session ${sessionId}`)
    }
    return session
  }

  protected now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async answerPrompt(
    input: Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]
  ): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    const prompt = session?.prompts.get(input.itemId)
    if (
      !session ||
      session.requestedClose ||
      session.fence !== input.fence ||
      !prompt ||
      prompt.claimed ||
      prompt.kind !== input.kind
    ) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    if ((prompt.kind === 'approval') !== (input.response.kind === 'option')) {
      throw new AgentSessionPromptAnswerRejectedError('response does not match provider prompt')
    }
    prompt.claimed = true
    try {
      await input.commit()
      if (
        this.sessions.get(input.sessionId) !== session ||
        session.requestedClose ||
        session.fence !== input.fence ||
        session.prompts.get(input.itemId) !== prompt
      ) {
        throw new AgentSessionPromptUnavailableError(input.itemId)
      }
      if (input.response.kind === 'option') {
        session.driver.answerPermission(prompt.requestId, input.response.optionId)
      } else {
        session.driver.answerInput(
          prompt.requestId,
          Object.fromEntries(
            input.response.answers.map((answer) => [
              answer.questionId,
              [...answer.optionIds, ...(answer.other ? [answer.other] : [])]
            ])
          )
        )
      }
      session.prompts.delete(input.itemId)
    } finally {
      prompt.claimed = false
    }
  }
}
