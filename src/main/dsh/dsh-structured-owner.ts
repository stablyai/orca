import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { DshAcpSession } from './dsh-acp-session'
import type { DshAcpConnection } from './dsh-acp-connection'
import type { DshAcpJournal } from './dsh-acp-journal'
import type { DshAcpOptions } from './dsh-acp-options'
import type { DshAcpPrompts } from './dsh-acp-prompts'

export type DshStructuredOwner = {
  fence: number
  generation: string
  session: DshAcpSession | null
  connection: DshAcpConnection | null
  providerSessionId: string
  journal: DshAcpJournal
  prompts: DshAcpPrompts
  options: DshAcpOptions
  optionRestoreFailures: string[]
  unbindReading?: () => void
  pending: { clientMessageId: string; providerIdentity: AgentJournalItemIdentity } | null
  ended: boolean
  stopped: boolean
  retryClose?: () => Promise<boolean>
}
