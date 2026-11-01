import type {
  NativeChatBlock,
  NativeChatToolCallBlock
} from '../../../../../src/shared/native-chat-types'

export type MobileNativeChatToolRunAsides = {
  before: ReadonlyMap<NativeChatBlock, readonly React.JSX.Element[]>
  after: readonly React.JSX.Element[]
}

export type MobileNativeChatToolRunProps = {
  blocks: NativeChatBlock[]
  // Previous plans let task-list updates render changes.
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  // Persist disclosure above recycled rows so remounting cannot lose the reader’s choice.
  disclosureId?: string
  asides?: MobileNativeChatToolRunAsides
  // Structured lifecycle state prevents orphaned calls from spinning forever.
  activeTurnIsWorking?: boolean
  /** Whether this run is the working turn's last. Only that run is live. */
  trailing?: boolean
  /** The turn is blocked on the reader's answer, so its calls decide liveness. */
  awaitingAnswer?: boolean
  fontScale?: number
  onOpenFile?: (path: string) => void
}
