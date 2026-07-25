// Maps ACP `session/request_permission` onto the approval card native chat
// already renders, and maps the operator's choice back to an ACP response.
//
// Why this is a bridge and not an auto-approver: an ACP agent asks the client
// before running a tool, and both target agents run their shell at the
// operator's trust level on the host. Answering "allow" automatically would
// silently remove an approval the operator currently sees in the terminal, so
// the request is surfaced to a human and nothing is granted without a choice.
//
// The existing `ChatApproval` contract is reused verbatim: the card takes
// `{title, detail?, options:[{label, send}]}` and hands `send` back untouched.
// For terminal agents `send` is a PTY literal; for ACP it is the ACP optionId.
// The card does not care, so no renderer change is needed.
//
// Kept pure (no JSON-RPC, no child process) so ordering and outcome mapping are
// unit-testable against literal protocol payloads.

/** `{title, detail?, options}` — structurally identical to the renderer's
 *  ChatApproval. Redeclared here rather than imported because main must not
 *  depend on renderer modules; the shape is asserted by tests on both sides. */
export type AcpApprovalCard = {
  title: string
  detail?: string
  options: { label: string; send: string }[]
}

/** ACP permission option kinds, in the order a human should see them. Allowing
 *  once is the common affirmative case and must come first — the card gives
 *  option 0 the primary styling, so a reject must never land there. */
const OPTION_KIND_RANK: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3
}

const UNKNOWN_KIND_RANK = 1.5

export type AcpPermissionRequestParams = {
  sessionId?: unknown
  toolCall?: unknown
  options?: unknown
}

export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

/** Render a tool call's input as a one-line detail string. Truncated because
 *  rawInput can hold a whole file body and the card is a single line of mono. */
const DETAIL_MAX = 300

function summarizeToolInput(toolCall: Record<string, unknown>): string | undefined {
  const raw = toolCall.rawInput
  if (raw == null) {
    return undefined
  }
  if (typeof raw === 'string') {
    return raw.slice(0, DETAIL_MAX)
  }
  if (typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>)
    // Prefer the fields an operator actually needs to judge the call.
    for (const key of ['command', 'path', 'file_path', 'abs_path', 'url']) {
      const found = entries.find(([name]) => name === key)
      if (found && (typeof found[1] === 'string' || typeof found[1] === 'number')) {
        return String(found[1]).slice(0, DETAIL_MAX)
      }
    }
    try {
      return JSON.stringify(raw).slice(0, DETAIL_MAX)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Build the approval card for a `session/request_permission` request.
 *
 * Returns null when the request carries no usable options — the caller must
 * then answer `cancelled` rather than inventing a grant.
 */
export function buildAcpApprovalCard(
  params: AcpPermissionRequestParams | null | undefined
): AcpApprovalCard | null {
  if (params == null || typeof params !== 'object') {
    return null
  }
  const rawOptions = Array.isArray(params.options) ? params.options : []
  const ranked: { label: string; send: string; rank: number }[] = []
  for (const entry of rawOptions) {
    if (entry == null || typeof entry !== 'object') {
      continue
    }
    const option = entry as Record<string, unknown>
    const optionId = typeof option.optionId === 'string' ? option.optionId : null
    if (optionId == null) {
      // Without an optionId there is nothing to answer with, so the option
      // cannot be offered — showing it would produce an unanswerable click.
      continue
    }
    const kind = typeof option.kind === 'string' ? option.kind : ''
    const label = typeof option.name === 'string' && option.name.length > 0 ? option.name : kind
    ranked.push({
      label: label.length > 0 ? label : optionId,
      send: optionId,
      rank: OPTION_KIND_RANK[kind] ?? UNKNOWN_KIND_RANK
    })
  }
  if (ranked.length === 0) {
    return null
  }
  // Stable sort by kind rank so agent-declared order within a kind is preserved.
  ranked.sort((a, b) => a.rank - b.rank)

  const toolCall =
    params.toolCall != null && typeof params.toolCall === 'object'
      ? (params.toolCall as Record<string, unknown>)
      : {}
  const title =
    typeof toolCall.title === 'string' && toolCall.title.length > 0
      ? toolCall.title
      : typeof toolCall.kind === 'string' && toolCall.kind.length > 0
        ? `Allow ${toolCall.kind}?`
        : 'Allow tool call?'

  const card: AcpApprovalCard = {
    title,
    options: ranked.map(({ label, send }) => ({ label, send }))
  }
  const detail = summarizeToolInput(toolCall)
  if (detail != null && detail.length > 0) {
    card.detail = detail
  }
  return card
}

/**
 * Map the operator's choice to an ACP permission response.
 *
 * A null/empty optionId means the operator dismissed the card or the request
 * had no answerable options — both are `cancelled`, never an implicit allow.
 */
export function buildAcpPermissionOutcome(
  optionId: string | null | undefined
): AcpPermissionOutcome {
  if (optionId == null || optionId.length === 0) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId } }
}

/** True when the chosen option is one the agent declared as a grant. Used for
 *  telemetry/logging only — the authority is the agent, which re-checks the
 *  optionId it receives. */
export function isAcpGrantOption(
  params: AcpPermissionRequestParams | null | undefined,
  optionId: string | null | undefined
): boolean {
  if (params == null || optionId == null || !Array.isArray(params.options)) {
    return false
  }
  for (const entry of params.options) {
    if (entry == null || typeof entry !== 'object') {
      continue
    }
    const option = entry as Record<string, unknown>
    if (option.optionId === optionId) {
      return option.kind === 'allow_once' || option.kind === 'allow_always'
    }
  }
  return false
}
