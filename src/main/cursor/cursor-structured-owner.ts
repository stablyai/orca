import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { CursorAcpSession } from './cursor-acp-session'
import type { CursorAcpConnection } from './cursor-acp-connection'
import type { CursorAcpJournal } from './cursor-acp-journal'
import type { CursorAcpOptions } from './cursor-acp-options'
import type { CursorAcpPrompts } from './cursor-acp-prompts'

export type CursorStructuredOwner = {
  fence: number
  generation: string
  session: CursorAcpSession | null
  connection: CursorAcpConnection | null
  providerSessionId: string
  journal: CursorAcpJournal
  prompts: CursorAcpPrompts
  options: CursorAcpOptions
  optionRestoreFailures: string[]
  unbindReading?: () => void
  pending: { clientMessageId: string; providerIdentity: AgentJournalItemIdentity } | null
  ended: boolean
  stopped: boolean
  retryClose?: () => Promise<boolean>
}
