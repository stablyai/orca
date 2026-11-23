import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { importClaudeTranscript } from './journal-claude-import'

type ImportInput = Parameters<typeof importClaudeTranscript>[0]

export type ClaudeImportWork = Omit<ImportInput, 'signal'>
export type ClaudeImportWorkerRequest = { kind: 'abort' }
export type ClaudeImportWorkerResponse =
  | { kind: 'imported'; result: Awaited<ReturnType<typeof importClaudeTranscript>> }
  | { kind: 'resource'; message: string }
  | { kind: 'refusal'; refusal: AgentSessionWireRefusal }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string }
