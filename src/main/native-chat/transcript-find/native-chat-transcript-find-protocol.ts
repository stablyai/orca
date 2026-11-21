import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatFindDocument } from '../../../shared/native-chat/find/native-chat-session-find'

/** A search names the transcript version it reads; the worker answers from its kept copy or asks
 *  for the bytes, which main reads through the transcript file layer (local, WSL or SSH). */
export type NativeChatTranscriptFindCommand =
  | {
      type: 'search'
      id: number
      /** Path, size and mtime: a changed file is a new version. */
      version: string
      agent: AgentType
      filePath: string
      query: string
    }
  | { type: 'chunk'; id: number; bytes: ArrayBuffer }
  | { type: 'end'; id: number }
  | { type: 'cancel'; id: number }

export type NativeChatTranscriptFindResponse =
  | { type: 'need-bytes'; id: number }
  | { type: 'ack'; id: number }
  | { type: 'done'; id: number; documents: NativeChatFindDocument[] }
  | { type: 'failed'; id: number; error: string }
