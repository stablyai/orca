import type { NativeChatSkillDiscoverySnapshot } from '../../../src/shared/native-chat/input/native-chat-picker-items'
import type { AskAnswerSelection } from '../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../src/shared/native-chat-turn-status'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import type { NativeChatAwaitingInput } from '../../../src/shared/native-chat/native-chat-terminal-turn'
import type { PendingNativeChatImage } from './native-chat/composer/mobile-native-chat-image-attachment'
import type { MobileNativeChatMicProps } from './native-chat/composer/MobileNativeChatComposerMic'
import type { MobileChatPermission } from './native-chat/input/mobile-native-chat-permission'
import type { MobileChatQuestion } from './native-chat/input/mobile-native-chat-question'
import type { MobileNativeChatSessionOptionPickersProps } from './native-chat/input/MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import type { OlderPagePhase } from './use-mobile-older-page-loader'
import type {
  MobileNativeChatSendProps,
  MobileNativeChatStructuredComposer
} from './native-chat/composer/mobile-native-chat-composer-props'
import type { ComposerTrayProps } from './native-chat/composer/use-mobile-native-chat-composer-tray'
import type { MobileNativeChatPendingItem } from './mobile-native-chat-render-data'

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export type Props = ComposerTrayProps & MobileNativeChatMicProps & ChatViewProps

export type ChatViewProps = MobileNativeChatSendProps & {
  // Keep raw messages to distinguish loading from a loaded transcript filtered to empty.
  setupAgentStartHeld?: boolean
  setupInputHeld?: boolean
  messages: NativeChatMessage[]
  folded: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  // Permanent read failure replaces the pane because further chat actions cannot succeed.
  readFailedFinally?: boolean
  agent?: string | null
  sessionLive?: boolean
  /** The turn is live: working, or waiting on the reader. */
  agentWorking?: boolean
  canStop?: boolean
  awaitingInput?: NativeChatAwaitingInput | null
  structuredActivityUi?: boolean
  turnIndicator?: NativeChatLiveTurnIndicator | null
  workingStartedAt?: number | null
  settledTurns?: NativeChatSettledTurns | null
  turnJournal?: NativeChatTurnJournal | null
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds?: readonly string[]
  onStop?: () => void
  // The overlay already gates partial text against authoritative transcript replacement.
  streaming: string | null
  hasMore?: boolean
  olderPages?: OlderPagePhase
  onLoadEarlier?: () => void
  // Fence send completion by route identity after tab/view switches.
  sendSurfaceId: string
  getSendCompletionGeneration: () => number
  getComposerEditGeneration: () => number
  pending: MobileNativeChatPendingItem[]
  // Retain local preview URIs after authoritative image messages replace optimistic rows.
  imagePreviewsByMessageId?: Record<string, string[]>
  composerScopeKey?: string | null
  draftKey: string | null
  onComposerTextChange: (text: string) => void
  onAttachImage?: () => void
  attachments?: PendingNativeChatImage[]
  onRemoveAttachment?: (id: string) => void
  isAttaching?: boolean
  inputLockReason?: MobileNativeChatInputLockReason | null
  // Report send failures here only while mounted; the route uses a toast otherwise.
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  filePaths?: string[]
  onNeedFiles?: (query: string) => void
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
  structuredComposer?: MobileNativeChatStructuredComposer | null
  ask?: AskPrompt | null
  // Keep dismissal identity above chat/terminal toggles.
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  askRequiresTerminal?: boolean
  onAnswerInTerminal?: () => void
  onCancelAsk?: () => Promise<boolean>
  onCancelPrompt?: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string, prompt?: MobileChatQuestion['prompt']) => Promise<boolean>
  permission?: MobileChatPermission | null
  promptKey?: string | null
  onRespondPermission?: (send: string) => Promise<boolean>
  onOpenFile?: (relativePath: string) => void
  keyboardInset?: number
}
