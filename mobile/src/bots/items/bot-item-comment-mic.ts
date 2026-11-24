import { createContext } from 'react'
import type { MobileNativeChatMicProps } from '../../session/native-chat/composer/dictation/MobileNativeChatComposerMic'

// The session screen's one dictation, for an item's comment box several sheets deep; none, no mic.
export const BotItemCommentMicContext = createContext<MobileNativeChatMicProps | null>(null)
