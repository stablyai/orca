import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'

export type LegacyTranscriptImportRequest = {
  agent: AgentType
  sessionId: string
  filePath: string
  transcriptAgent: 'claude' | 'codex' | 'grok' | 'omp'
  limits: JournalPayloadLimits
  validateSource: boolean
  decodedMessageIdentities?: true
  codexSessionsDirs?: string[]
  signal?: AbortSignal
}

export type PreparedLegacyImport =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean; forkTipItemIds?: string[] }
  | { ok: false; error: string }
