// Wire validation for `agentSession.*`.
//
// Strict objects throughout: zod drops unknown keys, and a silently dropped key
// is how a newer client's field becomes a different effect on an older host.
export {
  AcknowledgeAttentionParams,
  AgentsParams,
  AttachParams,
  CancelParams,
  ConversationCommandParams,
  CreateIntentParams,
  CreateParams,
  CreateSupportParams,
  HandoffStatusParams,
  HistoryParams,
  HoldParams,
  JournalCursor,
  ModelCatalogParams,
  MutationEnvelope,
  OptionsParams,
  QueuedMessageActionParams,
  QueuedMessagesResumeParams,
  RespondParams,
  RespondToQuestionParams,
  RestartResumableParams,
  RestartResumeParams,
  RewindParams,
  SendParams,
  SessionId,
  SetOptionParams,
  SubscribeParams,
  SubscribeTurnCompletionsParams,
  ThreadGoalParams,
  UnsubscribeParams
} from '../../../../shared/rpc-contract/structured-agent-session-params'
export { ContinueInterruptedParams } from '../../../../shared/rpc-contract/structured-agent-session-continue-params'
