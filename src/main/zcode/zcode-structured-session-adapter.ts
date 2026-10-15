// The structured-session adapter for ZCode: one `zcode app-server --stdio` child per Orca
// session, driven over the ZCode NDJSON protocol. Creates and resumes answer a whole
// conversation snapshot, so `acquire` seeds the journal and every send after that is `session/send`.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type AgentSessionCancelOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { acquireZcodeStructuredSession } from './zcode-structured-acquire'
import { isZcodeAppServerRequestError } from './zcode-app-server-request-error'
import { ZcodeAppServerTimeoutError } from './zcode-app-server-connection'
import { isZcodeStructuredOptionKey } from './zcode-structured-agent-definition'
import type {
  ZcodeLivePrompt,
  ZcodeStructuredSession,
  ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-state'
import type { ZcodeAppServerConnection } from './zcode-app-server-connection-types'

export type ZcodeStructuredSessionAdapterDepsWithLocation = ZcodeStructuredSessionAdapterDeps & {
  isWindowsProcessStartTimeAvailable?: () => boolean
}

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  /** Live children; a session the connection reported dead removes its own entry. */
  private readonly sessions = new Map<string, ZcodeStructuredSession>()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDepsWithLocation) {}

  // The child runs on this runtime's own machine; Windows needs process start-time proof.
  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const { acquisition, session } = await acquireZcodeStructuredSession({
      acquire: input,
      deps: {
        ...this.deps,
        // The connection's death is the adapter's `ended` event, once per session.
        onExitObserved: (error) => this.observeSessionExit(sessionId, error)
      }
    })
    this.sessions.set(sessionId, session)
    return acquisition
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return { state: 'unknown', reason: 'no live zcode session' }
    }
    await input.beforeDispatch?.()
    const text = input.body.blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
    try {
      await session.connection.request(
        'session/send',
        {
          sessionId: session.providerSessionId,
          content: text,
          // The model takes effect per send; an unset option stays absent on the wire.
          ...(session.options.get('model') ? { model: session.options.get('model') } : {})
        },
        { timeoutMs: this.deps.requestTimeoutMs ?? 30_000 }
      )
      return {
        state: 'accepted',
        providerIdentity: {
          provider: 'legacy',
          agent: 'zcode',
          sessionId: '',
          recordId: `message:${input.clientMessageId}`
        }
      }
    } catch (error) {
      if (error instanceof ZcodeAppServerTimeoutError) {
        // The send may still have landed: delivery is unproven, never re-sent on the user's behalf.
        throw error
      }
      if (isZcodeAppServerRequestError(error)) {
        // ZCode answered and refused (busy, read-only, unknown session): the chat says so.
        return {
          state: 'rejected',
          ...agentSessionFailureWords(
            agentSessionFailureFact('providerRejected', {
              detail: error.providerDiagnostic ?? providerDiagnostic(error.message, 'person')
            }),
            { surface: 'rejection', agentName: TUI_AGENT_DISPLAY_NAMES.zcode }
          )
        }
      }
      throw error
    }
  }

  async cancelTurn(input: {
    sessionId: string
    turnId?: string
    fence: number
  }): Promise<AgentSessionCancelOutcome> {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    try {
      // The one queue-bypassing call: it lands even while a turn holds the request lane.
      await session.connection.request('session/stop', {
        sessionId: session.providerSessionId
      })
      return { cancelled: true, ...(input.turnId ? { turnId: input.turnId } : {}) }
    } catch (error) {
      return {
        cancelled: false,
        refusal: {
          detail: error instanceof Error ? providerDiagnostic(error.message, 'log') : undefined,
          ...(isZcodeAppServerRequestError(error) ? { turnNotRunning: true as const } : {})
        }
      }
    }
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    response: AgentSessionPromptResponse
    fence: number
    commit: () => Promise<void>
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    const prompt = session?.prompts.get(input.itemId)
    if (!session || !prompt) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    const reply = buildZcodePromptReply(prompt, input.response)
    if (reply === null) {
      throw new AgentSessionPromptAnswerRejectedError(
        `the answer does not fit the ${prompt.method} request the agent asked`
      )
    }
    // The journal commit lands while the claim is held, then the child hears the answer.
    await input.commit()
    session.prompts.delete(input.itemId)
    session.connection.respond(prompt.requestId, reply)
  }

  /** The child asks through the reverse RPC; the acquire's notification handler routes it here. */
  recordPrompt(sessionId: string, prompt: ZcodeLivePrompt): void {
    this.sessions.get(sessionId)?.prompts.set(prompt.itemId, prompt)
  }

  async setOption(input: StructuredAgentSessionSetOptionInput): Promise<void> {
    if (!isZcodeStructuredOptionKey(input.key)) {
      throw new AgentSessionOptionRejectedError(
        `zcode app-server has no session option named ${input.key}`
      )
    }
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      throw new AgentSessionOptionRejectedError('no live zcode session')
    }
    // The protocol carries the model per create and per send, not as a live write; the value
    // takes effect on the next turn the host dispatches, which reads the session options.
    session.options.set(input.key, input.value)
  }

  readAcquisitionOptions(input: {
    sessionId: string
    fence: number
    priorOptions?: Readonly<Record<string, string>>
  }): Readonly<Record<string, string>> {
    const session = this.sessions.get(input.sessionId)
    return {
      ...input.priorOptions,
      ...Object.fromEntries(session?.options ?? [])
    }
  }

  holdsLiveProviderProcess(sessionId: string, acquisitionGeneration: string): boolean {
    const session = this.sessions.get(sessionId)
    return Boolean(
      session &&
      session.connection.pid !== undefined &&
      !session.ended &&
      session.acquisitionGeneration === acquisitionGeneration
    )
  }

  async closeSession(sessionId: string): Promise<boolean> {
    return this.closeOne(sessionId)
  }

  async forceCloseSession(sessionId: string): Promise<boolean> {
    return this.closeOne(sessionId)
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    return this.closeOne(sessionId)
  }

  private async closeOne(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    // Set before the close: the close ladder's own exit lands in the exit
    // observer, which must stay silent over the end this close publishes.
    session.orcaClose = true
    const proven = await session.connection.close().catch(() => false)
    // The exit observer marks the session ended without publishing when a close
    // asked for it, so this close owns exactly the one `ended` the host gets.
    session.ended = true
    session.unbindReadingControl?.()
    session.translator?.dispose()
    this.sessions.delete(sessionId)
    this.deps.onEvent?.({
      type: 'ended',
      sessionId,
      reason: 'the chat was closed',
      cause: 'requested-close',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      observedAt: this.deps.now?.() ?? Date.now()
    })
    return proven
  }

  /** The connection reported the child dead: end the record unless a close asked for this. */
  private observeSessionExit(sessionId: string, error: Error): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return
    }
    const observedAt = this.deps.now?.() ?? Date.now()
    session.ended = true
    session.exitObservedAt = observedAt
    session.unbindReadingControl?.()
    session.translator?.dispose()
    this.sessions.delete(sessionId)
    if (session.orcaClose) {
      // The close that asked for this exit publishes its own end.
      return
    }
    this.deps.onEvent?.({
      type: 'ended',
      sessionId,
      reason: error.message,
      cause: 'unexpected-exit',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      observedAt
    })
  }

  /** Quit and host teardown: every live child, its end reported like any unexpected exit. */
  async closeAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()]
    await Promise.all(sessionIds.map((sessionId) => this.closeOne(sessionId)))
  }
}

/** Maps an Orca prompt answer onto the ZCode reverse-RPC reply; null when it cannot. */
function buildZcodePromptReply(
  prompt: ZcodeLivePrompt,
  response: AgentSessionPromptResponse
): Record<string, unknown> | null {
  if (prompt.method === 'interaction/requestPermission') {
    if (response.kind !== 'option') {
      return null
    }
    // An option id is the ZCode decision word itself; anything else is a deny.
    return {
      decision:
        response.optionId === 'allow' || response.optionId === 'escalate'
          ? response.optionId
          : 'deny'
    }
  }
  if (prompt.method === 'interaction/requestUserInput') {
    if (response.kind === 'option') {
      return { action: response.optionId === 'accept' ? 'accept' : 'decline' }
    }
    const answer = response.answers[0]
    return answer ? { action: 'accept', content: answer.other ?? '' } : { action: 'cancel' }
  }
  return null
}

export type { ZcodeAppServerConnection }
