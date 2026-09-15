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
  HandoffParams,
  HandoffStatusParams,
  HistoryParams,
  HoldParams,
  JournalCursor,
  MutationEnvelope,
  OptionsParams,
  RespondParams,
  RewindParams,
  SendParams,
  SessionId,
  SetOptionParams,
  SubscribeParams,
  UnsubscribeParams
} from '../../../../shared/rpc-contract/structured-agent-session-params'
