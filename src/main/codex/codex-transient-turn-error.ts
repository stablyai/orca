import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  readCodexErrorInfo,
  readCodexErrorMessage,
  readCodexErrorWillRetry,
  readCodexTurnId
} from './codex-structured-thread-facts'

const TEMPORARY_ERRORS = new Set([
  'serverOverloaded',
  'internalServerError',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected'
])
const TEMPORARY_HTTP_STATUSES = new Set([408, 500, 502, 503, 504])

/** Only native, terminal error frames owned by this failed root turn can request recovery. */
export function codexTransientTurnError(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): string | null {
  const turnItem = items.find(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.turnId === turnId
  )
  const turn = readAgentJournalTurn(turnItem?.body)
  if (
    !turnItem ||
    turnItem.recovered ||
    turn?.state !== 'completed' ||
    turn.outcome !== 'failure'
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(turnItem.itemId)
  const providerTurnId =
    turn.providerTurnId ??
    (identity?.provider === 'legacy' &&
    identity.agent === 'codex' &&
    identity.recordId === `turn-lifecycle:${turn.turnId}`
      ? turn.turnId
      : null)
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    const frame = item?.body.kind === 'status' ? item.body.providerFrame : undefined
    if (
      !item ||
      !isRootAgentJournalItem(item) ||
      item.recovered ||
      item.turnScope?.kind !== 'turn' ||
      item.turnScope.turnItemId !== turnItem.itemId ||
      frame?.provider !== 'codex' ||
      frame.kind !== 'notification:error'
    ) {
      continue
    }
    // The last native error decides; a truncated or unknown final error must not expose an older one.
    if (frame.payload.truncated) {
      return null
    }
    let payload: unknown
    try {
      payload = JSON.parse(frame.payload.head)
    } catch {
      return null
    }
    if (readCodexErrorWillRetry(payload)) {
      continue
    }
    if (!providerTurnId || readCodexTurnId(payload) !== providerTurnId) {
      return null
    }
    const info = readCodexErrorInfo(payload)
    if (
      !info ||
      (!TEMPORARY_ERRORS.has(info.error) &&
        !(
          info.error === 'other' &&
          /^stream disconnected before completion(?::|$)/.test(readCodexErrorMessage(payload) ?? '')
        ))
    ) {
      return null
    }
    return info.status == null ||
      (typeof info.status === 'number' && TEMPORARY_HTTP_STATUSES.has(info.status))
      ? info.error
      : null
  }
  return null
}
