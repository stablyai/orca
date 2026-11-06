import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { AdoptedTranscriptObservation } from './adopted-transcript-observation'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalPayloadLimits } from './journal-payload-bounds'

export type LegacyTranscriptImportRequest = {
  agent: AgentType
  sessionId: string
  filePath: string
  transcriptAgent: 'claude' | 'codex' | 'grok' | 'omp'
  limits: JournalPayloadLimits
  validateSource: boolean
  decodedMessageIdentities?: true
  codexSessionsDirs?: string[]
}

export type PreparedLegacyImport =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean }
  | { ok: false; error: string }

export type LegacyImportCompletion =
  | { ok: true; sourceEmpty: boolean; itemCount: number; batchCount: number }
  | { ok: false; error: string }

export type LegacyImportWorkerMessage =
  | { type: 'validate-source'; observed: AdoptedTranscriptObservation }
  | { type: 'items'; index: number; items: JournalReplacementItem[] }
  | { type: 'result'; result: LegacyImportCompletion }

export type LegacyImportWorkerReply =
  | ({ type: 'validation' } & ({ ok: true } | { ok: false; error: string }))
  | { type: 'credit'; index: number }
