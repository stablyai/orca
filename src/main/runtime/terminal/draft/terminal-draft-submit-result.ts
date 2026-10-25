import type {
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../../shared/terminal-draft-contract'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'

/** Builds the submit answer from the two independent facts: draft applied, Enter settlement. */
export function buildSubmitResult(input: {
  replaced: Extract<TerminalDraftSaveResult, { ok: true }>
  written?: { accepted: boolean; writeSettlement?: WriteSettlement }
  error?: unknown
}): TerminalDraftSubmitResult {
  const { replaced, written, error } = input
  const textFields = {
    ...(replaced.text ? { text: replaced.text } : {}),
    ...(replaced.normalized ? { normalized: true } : {})
  }
  if (!written) {
    return {
      ok: true,
      status: 'submit_unknown',
      sourceToken: replaced.sourceToken,
      reason: error instanceof Error ? error.message : 'submit_failed',
      ...textFields
    }
  }
  const settlement = written.writeSettlement
  if (settlement?.outcome === 'unverifiable') {
    return {
      ok: true,
      status: 'submit_unknown',
      sourceToken: replaced.sourceToken,
      reason: settlement.reason,
      ...textFields
    }
  }
  if (written.accepted) {
    return { ok: true, status: 'submitted', sourceToken: replaced.sourceToken }
  }
  return {
    ok: true,
    status: 'saved_not_submitted',
    sourceToken: replaced.sourceToken,
    submitRefused: true,
    ...textFields
  }
}
