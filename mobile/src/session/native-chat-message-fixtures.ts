import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

function textMessage(
  role: 'assistant' | 'user',
  id: string,
  text: string
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

export function userTextMessage(id: string, text: string): NativeChatMessage {
  return textMessage('user', id, text)
}

export function assistantTextMessage(id: string, text: string): NativeChatMessage {
  return textMessage('assistant', id, text)
}
