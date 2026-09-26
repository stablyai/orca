// Wire validation for `agentSession.*`.
//
// Strict objects throughout: zod drops unknown keys, and a silently dropped key
// is how a newer client's field becomes a different effect on an older host.
export {
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
  RespondParams,
  RespondToQuestionParams,
  RestartResumableParams,
  RestartResumeParams,
  RewindParams,
  SendParams,
  SessionId,
  SetOptionParams,
  SubscribeParams,
  ThreadGoalParams,
  UnsubscribeParams
} from '../../../../shared/rpc-contract/structured-agent-session-params'
