import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalForkStageBegin } from './journal-fork-stages'
type Auxiliary = {
  item: AgentJournalRenderItem
  ordinal: number
  oldNames: readonly string[]
  oldName: number
  names: readonly string[]
  name: number
  claims: readonly string[]
  claim: number
}
export type Stage = JournalForkStageBegin & {
  token: string
  epoch: string
  priorSequence: number
  priorRecord: string | null
  count: number
  lastItemId: string | null
  derived: string | null
  lastActivity: number
  auxiliary?: Auxiliary
}
