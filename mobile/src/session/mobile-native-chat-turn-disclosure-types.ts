import type { NativeChatLiveLine } from '../../../src/shared/native-chat-live-line'
import type { NativeChatTurnStatus } from './use-mobile-native-chat-turn-status'

export type MobileNativeChatTurnRow = {
  turnStatus: NativeChatTurnStatus | null
  turnStatusAbove?: boolean
  turnExpanded: boolean
  turnKey?: string
  activeTurnIsWorking: boolean
  reasoningIsLive: boolean
  reasoningExpanded: boolean
  onToggleReasoning: (key: string) => void
}

export type MobileNativeChatLiveLine = NativeChatLiveLine & { reasoningExpanded: boolean }
