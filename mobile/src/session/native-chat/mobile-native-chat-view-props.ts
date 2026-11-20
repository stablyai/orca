import type { MobileSessionItemNavigation } from '../mobile-session-item-target'
import type { NativeChatSkillDiscoverySnapshot } from '../../../../src/shared/native-chat/input/composer/native-chat-picker-items'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { NativeChatResolvedPrompt } from '../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import type { NativeChatContextUsageSummary } from '../../../../src/shared/native-chat/native-chat-context-usage-summary'
import type { NativeChatAwaitingInput } from '../../../../src/shared/native-chat/transcript/turns/native-chat-terminal-turn'
import type { PendingNativeChatImage } from './composer/attachments/mobile-native-chat-image-attachment'
import type { MobilePastedImages } from './composer/attachments/mobile-native-chat-composer-paste'
import type { MobileNativeChatStructuredComposer } from './composer/commands/mobile-native-chat-structured-composer'
import type { MobileNativeChatSessionOptionPickersProps } from './input/session-options/MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatStatus } from './status/mobile-native-chat-session-status'
import type { OlderPagePhase } from './transcript/ingestion/use-mobile-older-page-loader'
import type {
  NativeChatLiveTurnIndicator,
  NativeChatSettledTurns
} from '../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { ComponentProps } from 'react'
import type { MobileNativeChatSendProps } from './composer/MobileNativeChatComposer'
import type { MobileNativeChatPromptCard } from './input/prompts/MobileNativeChatPromptCard'
import type { MobileNativeChatInputLockStatus } from './composer/field/MobileNativeChatInputLockStatus'
import type { MobileNativeChatPendingItem } from './transcript/projection/mobile-native-chat-render-data'
import type { MobileWorkerApprovals } from './input/prompts/use-mobile-worker-approvals'

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export type MobileNativeChatViewProps = MobileNativeChatSendProps &
  Omit<ComponentProps<typeof MobileNativeChatPromptCard>, 'answering' | 'requiresTerminal'> & {
    // Keep raw messages to distinguish loading from a loaded transcript filtered to empty.
    itemNavigation?: MobileSessionItemNavigation | null
    /** Workers' open prompts for a coordinator chat; shown above the chat's own prompt. */
    workerApprovals?: MobileWorkerApprovals
    messages: NativeChatMessage[]
    folded: NativeChatMessage[]
    status: MobileNativeChatStatus
    error?: string
    // Permanent read failure replaces the pane because further chat actions cannot succeed.
    readFailedFinally?: boolean
    /** A sent /clear hid the old rows: show a blank list until its divider lands, not the new-chat copy. */
    clearing?: boolean
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
    onPasteImages?: (paste: MobilePastedImages) => void
    attachments?: PendingNativeChatImage[]
    onRemoveAttachment?: (id: string) => void
    isAttaching?: boolean
    inputLockReason?: MobileNativeChatInputLockReason | null
    /** Why a `disconnected` lock holds: which host is out, and Reconnect when it can help. */
    hostOutage?: ComponentProps<typeof MobileNativeChatInputLockStatus>['hostOutage']
    // Report send failures here only while mounted; the route uses a toast otherwise.
    sendErrorMessage?: string | null
    onClearSendError?: () => void
    /** Present for an error that stays until dismissed, such as a failed Continue. */
    onDismissSendError?: () => void
    filePaths?: string[]
    onNeedFiles?: (query: string) => void
    skillDiscovery?: NativeChatSkillDiscoverySnapshot
    onNeedSkills?: () => void
    sessionOptions?: MobileNativeChatSessionOptionPickersProps | null
    contextUsage?: NativeChatContextUsageSummary | null
    structuredComposer?: MobileNativeChatStructuredComposer | null
    askRequiresTerminal?: boolean
    promptKey?: string | null
    onOpenFile?: (relativePath: string) => void
    keyboardInset?: number
  }
