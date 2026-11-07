import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type * as SessionAdapter from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudePendingPrompt } from '../claude-prompt-registry'
import type { ClaudeStartedSend } from './claude-structured-session-state'

export type ClaudeAuthDiagnostic = {
  apiKeySourceConfigured: boolean
  baseUrlConfigured: boolean
  authTokenConfigured: boolean
  apiKeyConfigured: boolean
  settingSources: readonly string[]
}

export type ClaudeStructuredSessionEvent =
  | {
      type: 'message'
      sessionId: string
      message: Record<string, unknown>
      /** Present when an acknowledged replay opens a turn; folded replays only settle delivery. */
      startsTurn?: true
      /** Submission time for the acknowledged dispatch, absent when its send is unknown. */
      requestedAt?: number
      /** The submission this replay acknowledged, which opens the turn. */
      clientMessageId?: string
      /** On any other frame: the send the CLI started and has not echoed, whose turn output opens. */
      startedSend?: ClaudeStartedSend
      /** Host clock at receipt; stamped on turn boundaries only. */
      observedAt?: number
    }
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
  | SessionAdapter.StructuredAgentSessionOptionsReportedEvent
  | (SessionAdapter.StructuredAgentSessionRetiringEvent & {
      providerSessionId: string
      unopenedSend?: ClaudeStartedSend
    })
  | {
      type: 'ended'
      sessionId: string
      reason: string
      failure?: SubmissionRejectionFact
      deathEvidenceKind?: 'kill-delivered'
      /** Present for first-hand child exits so the host can fence recovery. */
      cause?: 'unexpected-exit' | 'requested-close'
      fence?: number
      acquisitionGeneration?: string
      /** Host clock when the end was observed. */
      observedAt?: number
    }
