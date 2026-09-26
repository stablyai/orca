import type {
  ScheduledMessage,
  ScheduledMessageFailureReason,
  ScheduledMessagesSnapshot
} from '../shared/scheduled-message-types'

/** Some CLIs blip through idle between tool calls; settling avoids racing the
 *  next `working` title on every such blip. */
export const IDLE_EDGE_SETTLE_MS = 3_000

export type ScheduledMessageNotification = {
  kind: 'sent' | 'missed' | 'failed'
  worktreeId: string
  messageId: string
  failureReason?: ScheduledMessageFailureReason
}

/** Resolved at delivery time, not at compose time: panes die and are replaced
 *  across a wait of hours. */
export type ScheduledMessagePaneTarget = {
  handle: string
  ptyId: string | null
}

type ScheduledMessageStore = {
  listScheduledMessages: () => ScheduledMessage[]
  putScheduledMessage: (message: ScheduledMessage) => void
  deleteScheduledMessage: (messageId: string) => void
}

export type ScheduledMessageServiceOptions = {
  store: ScheduledMessageStore
  resolveAgentPane: (worktreeId: string) => Promise<ScheduledMessagePaneTarget | null>
  /** Rejects rather than typing into a shell, and re-checks both options at the
   *  write itself, not just on entry. */
  deliver: (
    handle: string,
    text: string,
    options: { requireIdleAgent: boolean; stillWanted: () => boolean }
  ) => Promise<void>
  /** True while the pane sits on a usage-limit banner or menu; on a menu it also
   *  picks "wait for reset", so the tail is read once rather than twice. */
  deferForUsageLimit: (ptyId: string, handle: string) => Promise<boolean>
  /** Idle *right now*: the edge that armed the settle timer is seconds old by the
   *  time it fires, and the user may have typed since. */
  isAgentIdle?: (pane: ScheduledMessagePaneTarget) => Promise<boolean>
  createId: () => string
  notify?: (notification: ScheduledMessageNotification) => void
  onSnapshot?: (snapshot: ScheduledMessagesSnapshot) => void
  tickMs?: number
  missedGraceMs?: number
  maxUsageLimitWaitMs?: number
  idleSettleMs?: number
  now?: () => number
  logger?: Pick<Console, 'debug' | 'warn'>
}
