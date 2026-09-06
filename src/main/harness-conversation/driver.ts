import type { NativeChatMessage } from '../../shared/native-chat-types'
import type {
  StructuredMachineAgent,
  StructuredProviderConfiguration,
  StructuredProviderInput,
  StructuredProviderPermission
} from '../../shared/structured-agent-provider'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type { AgentSubagentSnapshot } from '../../shared/agent-status-types'

export type HarnessConversationDriverSink = {
  emit: (event: HarnessConversationDriverEvent) => void
  setProviderSessionId: (sessionId: string) => void
  setConfiguration: (configuration: StructuredProviderConfiguration) => void
  setContext: (context: AgentSessionContextSnapshot) => void
  setSubagents: (subagents: AgentSubagentSnapshot[]) => void
  setTranscriptPath: (transcriptPath: string) => void
  setProcessId?: (pid: number) => void
  end?: (reason: string) => void
}

export type HarnessConversationDriverEvent =
  | { type: 'message.started'; message: NativeChatMessage }
  | { type: 'message.delta'; messageId: string; blockIndex: number; offset: number; text: string }
  | { type: 'message.completed'; message: NativeChatMessage }
  | { type: 'permission'; permission: StructuredProviderPermission | null }
  | { type: 'input'; input: StructuredProviderInput | null }

export type HarnessConversationDriver = {
  ready?(): Promise<void>
  send(
    text: string,
    imagePaths?: readonly string[],
    submission?: HarnessConversationSubmission
  ): Promise<void>
  steer?(
    text: string,
    imagePaths: readonly string[] | undefined,
    clientMessageId: string,
    accept: (result: HarnessConversationSteerAcceptance) => Promise<void>
  ): Promise<void>
  interrupt(): Promise<void>
  answerPermission(requestId: string, optionId: string): void
  answerInput(requestId: string, answers: Record<string, string[]>): void
  setOption?(optionId: string, value: SessionOptionValue): Promise<void>
  compact?(): Promise<void>
  close(): Promise<void>
}

export type HarnessConversationSubmission = {
  clientMessageId: string
  accepted: () => void
}

export type HarnessConversationSteerAcceptance =
  | { placement: 'current' }
  | { placement: 'next'; completion: Promise<void> }

export type HarnessConversationDriverFactory = (input: {
  conversationId: string
  agent: StructuredMachineAgent
  cwd: string
  providerSessionId: string | null
  newProviderSessionId?: string
  forkFromProviderSessionId: string | null
  spawnToken: string
  providerEnvironment?: Record<string, string>
  sink: HarnessConversationDriverSink
}) => Promise<HarnessConversationDriver>

export type PendingPermission = {
  request: StructuredProviderPermission
  resolve: (optionId: string) => void
}
