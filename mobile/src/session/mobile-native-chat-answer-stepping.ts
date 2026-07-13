import {
  nativeChatQuestionOffsets,
  scheduleNativeChatAnswer,
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../src/shared/native-chat-answer-stepping'

export const MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS = NATIVE_CHAT_ADVANCE_BUFFER_MS
export const MOBILE_NATIVE_CHAT_QUESTION_STEP_MS = NATIVE_CHAT_QUESTION_STEP_MS
export const MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS = NATIVE_CHAT_SUBMIT_DELAY_MS
export const mobileNativeChatQuestionOffsets = nativeChatQuestionOffsets
export const scheduleMobileClaudeAnswer = scheduleNativeChatAnswer
