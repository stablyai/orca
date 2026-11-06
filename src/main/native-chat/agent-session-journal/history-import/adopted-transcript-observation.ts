import { sessionIdFromFileName } from '../../../ai-vault/session-scanner-accumulator'
import { extractString } from '../../../ai-vault/session-scanner-values'
import { asRecord } from '../../../ai-vault/session-scanner-record-value'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'

export type AdoptedTranscriptObservation = { sessionId: string | null; cwd: string | null }

/** Observe the original records, including metadata outside the retained history window. */
export function createAdoptedTranscriptObservation(agent: AgentType, filePath: string) {
  const observed: AdoptedTranscriptObservation = {
    sessionId: agent === 'claude' || agent === 'codex' ? sessionIdFromFileName(filePath) : null,
    cwd: null
  }
  let sawCodexMetadata = false
  return {
    observed,
    observe(record: Record<string, unknown> | null) {
      if (!record) {
        return
      }
      if (agent === 'claude') {
        observed.sessionId = extractString(record.sessionId) ?? observed.sessionId
        observed.cwd ??= extractString(record.cwd)
      } else if (agent === 'codex' && record.type === 'session_meta' && !sawCodexMetadata) {
        sawCodexMetadata = true
        observed.sessionId = extractString(asRecord(record.payload)?.id) ?? observed.sessionId
      } else if ((agent === 'omp' || agent === 'pi') && record.type === 'session') {
        observed.sessionId = extractString(record.id)
        observed.cwd = extractString(record.cwd)
      }
    }
  }
}
