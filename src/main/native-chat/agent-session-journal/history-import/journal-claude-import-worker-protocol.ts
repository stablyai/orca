import type { AdoptedSourceIdentity } from './adopted-transcript-source'
import type { ClaudeSourceVersion } from './journal-claude-import-source'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { ClaudeImportInput } from './journal-claude-import'

export const CLAUDE_IMPORT_PAGE_BYTES = 512 * 1024
// The enclosing reply has only the page kind and the relay envelope.
export const CLAUDE_IMPORT_PAGE_DATA_BYTES = CLAUDE_IMPORT_PAGE_BYTES - 256

export type ClaudeImportWork = Omit<ClaudeImportInput, 'signal'>
export type ClaudeImportHeader = {
  count: number
  sourceEmpty: boolean
  identity?: AdoptedSourceIdentity
}
export type ClaudeImportPage = { kind: 'page'; bytes: Uint8Array }
export type ClaudeImportWorkerRequest = { kind: 'pull' | 'verify' | 'close' }
export type ClaudeImportWorkerResponse =
  | { kind: 'imported'; header: ClaudeImportHeader }
  | ClaudeImportPage
  | { kind: 'verified'; version: ClaudeSourceVersion }
  | { kind: 'finished' | 'closed' }
  | { kind: 'resource'; message: string }
  | { kind: 'refusal'; refusal: AgentSessionWireRefusal }
  | { kind: 'failed'; message: string }
