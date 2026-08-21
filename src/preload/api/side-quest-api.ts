import type {
  SideQuestCreateArgs,
  SideQuestCreateResult,
  SideQuestInterruptArgs,
  SideQuestReadArgs,
  SideQuestReadResult,
  SideQuestSendArgs,
  SideQuestSendResult,
  SideQuestStreamEvent,
  SideQuestSubscribeArgs
} from '../../shared/side-quest-runtime-types'

export type SideQuestApi = {
  create: (args: SideQuestCreateArgs) => Promise<SideQuestCreateResult>
  read: (args: SideQuestReadArgs) => Promise<SideQuestReadResult>
  send: (args: SideQuestSendArgs) => Promise<SideQuestSendResult>
  interrupt: (args: SideQuestInterruptArgs) => Promise<void>
  subscribe: (
    args: SideQuestSubscribeArgs,
    onEvent: (event: SideQuestStreamEvent) => void
  ) => () => void
}
