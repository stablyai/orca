import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalRewindCut, JournalRewindSelection } from './journal-domain-rewind-cut'
import {
  JOURNAL_REWIND_CONTEXT,
  JOURNAL_REWIND_JOINS,
  rewindMember,
  rewindPosition,
  rewindContextBindings,
  rewindRetainedTurns,
  rewindKept,
  type JournalRewindMembership
} from './journal-domain-rewind-membership'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineKeyPart,
  providerTimelineTurnKeyPart
} from '../agent-session-timeline/provider-timeline-identity'

export function planProviderTimelineRewindCut(
  scope: JournalSqlScope,
  target: JournalRewindSelection,
  floor: number
): { cut: JournalRewindCut; membership: JournalRewindMembership } | null {
  const { db, prefix } = scope
  const root = db
    .prepare(`SELECT item_id,turn_id,provider_turn_id,sequence,sequence_index,ordinal
    FROM journal_items INDEXED BY journal_items_opener
    WHERE session_id=? AND epoch=? AND hidden=0 AND opener_item_id=? AND opener_item_id IS NOT NULL
      AND root=1 AND turn_id IS NOT NULL ORDER BY ordinal LIMIT 1`)
    .get(...prefix, target.itemId)
  if (!root) {
    return null
  }
  scope.examined(root)
  const turnId = String(root.turn_id)
  const part = providerTimelineTurnKeyPart(turnId)
  if (!isProviderTimelineTurnInNamespace(turnId, target.nativeId) || !part || part.includes('#')) {
    return null
  }
  let beforeTurnId: string
  try {
    beforeTurnId = decodeURIComponent(part)
  } catch {
    return null
  }
  if (root.provider_turn_id !== null && String(root.provider_turn_id) !== beforeTurnId) {
    return null
  }
  const membership: JournalRewindMembership = {
    floor,
    boundary: rewindPosition(root),
    nativeId: target.nativeId,
    scope: 'provider-timeline'
  }
  const boundary = db
    .prepare(`${JOURNAL_REWIND_CONTEXT}
    SELECT item.sequence,item.sequence_index,item.ordinal FROM rewind_context context
    CROSS JOIN journal_items item INDEXED BY journal_items_visible_position ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.hidden=0
      AND item.sequence>context.floor AND (${rewindMember(membership.scope)})=?
    ORDER BY item.sequence,item.sequence_index,item.ordinal LIMIT 1`)
    .get(...rewindContextBindings(scope, membership), String(root.item_id))
  if (!boundary) {
    return null
  }
  scope.examined(boundary)
  membership.boundary = rewindPosition(boundary)
  const turnPrefix = `p:${providerTimelineKeyPart(target.nativeId)}:`
  const last = db
    .prepare(`${rewindRetainedTurns(membership.scope)}
    SELECT item.turn_id FROM rewind_context context
    CROSS JOIN journal_items item INDEXED BY journal_items_named_turn ${JOURNAL_REWIND_JOINS}
    WHERE item.session_id=context.session_id AND item.epoch=context.epoch AND item.hidden=0
      AND item.root=1 AND item.turn_id IS NOT NULL AND substr(item.turn_id,1,?)=?
      AND (item.sequence<=context.floor OR (${rewindKept(membership.scope)}))
    ORDER BY item.sequence DESC,item.sequence_index DESC,item.ordinal DESC LIMIT 1`)
    .get(...rewindContextBindings(scope, membership), turnPrefix.length, turnPrefix)
  const keptPart = last ? providerTimelineTurnKeyPart(String(scope.examined(last).turn_id)) : null
  if (keptPart?.includes('#')) {
    return null
  }
  let keptTurnId: string | null = null
  try {
    keptTurnId = keptPart ? decodeURIComponent(keptPart) : null
  } catch {
    return null
  }
  return {
    membership,
    cut: { floor, providerItemId: target.itemId, beforeTurnId, keptTurnId }
  }
}
