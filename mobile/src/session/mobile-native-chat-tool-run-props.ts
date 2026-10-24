import type {
  NativeChatBlock,
  NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'

/** Desktop parity: `NativeChatToolRunAsides`. Rows drawn among an open run's lines, each keyed:
 *  before the block they are keyed by, or after the last. */
export type MobileNativeChatToolRunAsides = {
  before: ReadonlyMap<NativeChatBlock, readonly React.JSX.Element[]>
  after: readonly React.JSX.Element[]
}

export type MobileNativeChatToolRunProps = {
  blocks: NativeChatBlock[]
  /** The last plan each task-list tool wrote before this run, so an update reads as its changes. */
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  /** The row this run belongs to. The list recycles rows, so what the reader opened is
   *  remembered somewhere that outlives the row. */
  disclosureId?: string
  /** Rows drawn among the run's lines, each before the block it is keyed by, or after the last. */
  asides?: MobileNativeChatToolRunAsides
  /** Structured lifecycle state; keeps an orphaned running call from spinning. */
  activeTurnIsWorking?: boolean
  /** Whether this run is the working turn's last. Only that run is live. */
  trailing?: boolean
  /** The turn is blocked on the reader's answer, so its calls decide liveness. */
  awaitingAnswer?: boolean
  fontScale?: number
  onOpenFile?: (path: string) => void
}
