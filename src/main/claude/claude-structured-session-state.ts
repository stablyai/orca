import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ClaudeStreamJsonConnection,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudePendingPrompt, ClaudePromptRegistry } from './claude-structured-prompt-replies'

export type ClaudeAuthDiagnostic = {
  apiKeySourceConfigured: boolean
  baseUrlConfigured: boolean
  authTokenConfigured: boolean
  apiKeyConfigured: boolean
  settingSources: readonly string[]
}

export type ClaudeStructuredSessionEvent =
  | { type: 'message'; sessionId: string; message: Record<string, unknown> }
  | { type: 'provider-frame'; sessionId: string; kind: string; payload: unknown }
  | { type: 'prompt'; sessionId: string; prompt: ClaudePendingPrompt }
  | { type: 'prompt-cancelled'; sessionId: string; promptKey: string }
  | { type: 'options'; sessionId: string; models: unknown[] }
  | {
      type: 'handle'
      sessionId: string
      providerSessionId: string
      leafUuid: string | null
      fence: number
    }
  | { type: 'auth-diagnostic'; sessionId: string; diagnostic: ClaudeAuthDiagnostic }
  | { type: 'ended'; sessionId: string; reason: string }

export type ClaudeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<ClaudeStructuredLaunch>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
  openConnection?: typeof openClaudeStreamJsonConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  now?: () => number
  requestTimeoutMs?: number
  initTimeoutMs?: number
  dispatchAckTimeoutMs?: number
  persistHandle?: (input: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
}

export type ClaudeDispatchWaiter = {
  resolve: (uuid: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

export type ClaudeSession = {
  connection: ClaudeStreamJsonConnection
  providerSessionId: string
  leafUuid: string | null
  fence: number
  prompts: ClaudePromptRegistry
  dispatchWaiters: ClaudeDispatchWaiter[]
  options: Map<string, string>
  reportedOptions: { model?: string; effort?: string }
  translator: ClaudeJournalTranslator | null
  events: StructuredAgentSessionEventSink | undefined
}

export type ClaudeAcquisitionAttempt = {
  connection: ClaudeStreamJsonConnection | null
  prompts: ClaudePromptRegistry
  buffered: (() => void)[]
  published: boolean
  cancelled: boolean
  finished: Promise<void>
  finish: () => void
}

export function createClaudeAcquisitionAttempt(
  prompts: ClaudePromptRegistry
): ClaudeAcquisitionAttempt {
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    connection: null,
    prompts,
    buffered: [],
    published: false,
    cancelled: false,
    finished,
    finish
  }
}

export class ClaudeAcquisitionRegistry {
  private readonly attempts = new Map<string, ClaudeAcquisitionAttempt>()
  private closing = false

  get size(): number {
    return this.attempts.size
  }

  start(
    sessionId: string,
    prompts: ClaudePromptRegistry
  ): {
    previous: ClaudeAcquisitionAttempt | undefined
    attempt: ClaudeAcquisitionAttempt
  } {
    if (this.closing) {
      throw new Error('claude structured session adapter is closing')
    }
    const previous = this.attempts.get(sessionId)
    const attempt = createClaudeAcquisitionAttempt(prompts)
    this.attempts.set(sessionId, attempt)
    return { previous, attempt }
  }

  assertCurrent(sessionId: string, attempt: ClaudeAcquisitionAttempt): void {
    if (this.closing || attempt.cancelled || this.attempts.get(sessionId) !== attempt) {
      throw new Error(`claude session ${sessionId} was superseded while being acquired`)
    }
  }

  get(sessionId: string): ClaudeAcquisitionAttempt | undefined {
    return this.attempts.get(sessionId)
  }

  deleteIfCurrent(sessionId: string, attempt: ClaudeAcquisitionAttempt): void {
    if (this.attempts.get(sessionId) === attempt) {
      this.attempts.delete(sessionId)
    }
  }

  sessionIds(): IterableIterator<string> {
    return this.attempts.keys()
  }

  close(): void {
    this.closing = true
  }
}

export async function cancelClaudeAcquisitionAttempt(
  attempt: ClaudeAcquisitionAttempt | undefined
): Promise<void> {
  if (!attempt) {
    return
  }
  attempt.cancelled = true
  await attempt.connection?.close()
  await attempt.finished
}
