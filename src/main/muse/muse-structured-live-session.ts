import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { MspClient } from './msp-client'
import type { MspStructuredSession } from './msp-session'
import type { MspJournalTranslator } from './msp-journal-translation'
import type { MspPromptRef } from './muse-structured-session-prompts'

export type MspLiveSession = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  client: MspClient
  msp: MspStructuredSession
  translator: MspJournalTranslator
  sink: StructuredAgentSessionEventSink
  pid: number | undefined
  journalClosed: string | null
  ended: boolean
  closeRequested: boolean
  turnId: string | null
  pendingTurn: {
    clientMessageId: string
    requestedAt: number
  } | null
  options: { model?: string; effort?: string; permissionProfile?: string }
  onEvent: (event: StructuredAgentSessionLifecycleEvent) => void
  prompts: Map<string, MspPromptRef>
}
