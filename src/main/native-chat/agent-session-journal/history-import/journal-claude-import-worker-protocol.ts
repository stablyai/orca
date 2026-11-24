import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { importClaudeTranscript } from './journal-claude-import'

type ImportInput = Parameters<typeof importClaudeTranscript>[0]
type ImportResult = Awaited<ReturnType<typeof importClaudeTranscript>>

export const CLAUDE_IMPORT_PAGE_BYTES = 512 * 1024
export const CLAUDE_IMPORT_REPLY_FRAMING_BYTES = 64
export const CLAUDE_IMPORT_PAGE_ENTRIES = 256

export type ClaudeImportWork = Omit<ImportInput, 'signal'>
export type ClaudeImportHeader = Omit<ImportResult, 'items' | 'savedKeys' | 'retainedBytes'>
export type ClaudeImportItem = { item: JournalReplacementItem; keys: string[]; bytes: number }
type MessageItem = JournalReplacementItem & {
  body: Extract<AgentJournalItemBody, { kind: 'message' }>
}

export type ClaudeImportItemPart =
  | ({ kind: 'item' } & ClaudeImportItem)
  | { kind: 'start'; item: MessageItem; bytes: number }
  | { kind: 'key'; key: string }
  | { kind: 'block'; block: NativeChatBlock }
  | { kind: 'end' }

export type ClaudeImportFieldFragment =
  | { kind: 'wide-field'; path: string[]; value: unknown }
  | { kind: 'wide-text'; path: string[]; text: string }

export type ClaudeImportEntry =
  | ClaudeImportItemPart
  | ClaudeImportFieldFragment
  | { kind: 'wide-start' }
  | { kind: 'wide-end' }

export type ClaudeImportPage = { kind: 'page'; entries: ClaudeImportEntry[]; done: boolean }
export type ClaudeImportWorkerRequest = { kind: 'abort' } | { kind: 'pull' }
export type ClaudeImportWorkerResponse =
  | { kind: 'imported'; header: ClaudeImportHeader }
  | ClaudeImportPage
  | { kind: 'resource'; message: string }
  | { kind: 'refusal'; refusal: AgentSessionWireRefusal }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string }
