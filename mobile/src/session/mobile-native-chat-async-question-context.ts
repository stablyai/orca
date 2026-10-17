import { createContext } from 'react'
import type { NativeChatAsyncQuestionReply } from '../../../src/shared/native-chat-async-questions'

export const MobileNativeChatAsyncQuestionContext =
  createContext<NativeChatAsyncQuestionReply | null>(null)
