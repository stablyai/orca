import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './projection/journal-reducer'
import { memoryJournalMap } from './journal-memory-collections'
import { journalInputPresentationMember } from './input-order/journal-input-obligations'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { withoutNativeChatVisualDirectiveLines } from '../../../shared/native-chat/native-chat-visual-directive'

export type JournalStatusPosition = { sequence: number; sequenceIndex: number; ordinal: number }
export type JournalStatusItem = { item: AgentJournalRenderItem; position: JournalStatusPosition }
export type JournalStatusItemSelection =
  | { kind: 'boundary'; raw?: true }
  | { kind: 'clear' }
  | { kind: 'turns'; root?: true; floor?: number; direction?: 'asc' | 'desc' }
  | { kind: 'users'; floor?: number; unknown?: true }
  | { kind: 'assistant-prose'; floor?: number }
  | { kind: 'assistant-exists' }
  | { kind: 'prompt' }
  | { kind: 'pending-prompts'; floor?: number }
  | { kind: 'scoped-statuses'; turnItemId: string; floor?: number }
  | { kind: 'tools'; after: JournalStatusPosition; running?: true }

export function compareJournalStatusPositions(a: JournalStatusPosition, b: JournalStatusPosition) {
  return a.sequence - b.sequence || a.sequenceIndex - b.sequenceIndex || a.ordinal - b.ordinal
}

/** Test/restore owner: SQL uses the same named populations without enumerating this map. */
export function* memoryJournalStatusItems(
  state: JournalReducerState,
  selection: JournalStatusItemSelection
): Iterable<JournalStatusItem> {
  const selected: JournalStatusItem[] = []
  let ordinal = 0
  for (const item of memoryJournalMap(state.items).values()) {
    const position = {
      sequence: item.sequence,
      sequenceIndex: item.sequenceIndex ?? 0,
      ordinal: ordinal++
    }
    if (
      !(selection.kind === 'boundary' && selection.raw) &&
      !journalInputPresentationMember(state, item.itemId)
    ) {
      continue
    }
    if ('floor' in selection && selection.floor && item.sequence <= selection.floor) {
      continue
    }
    const root = isRootAgentJournalItem(item)
    const body = item.body
    const user =
      root && body.kind === 'message' && body.role === 'user' && body.command === undefined
    let matches: boolean
    switch (selection.kind) {
      case 'clear':
        matches = isAgentSessionContextClear(body)
        break
      case 'boundary':
        matches = readAgentJournalTurn(body) !== null || isAgentSessionContextClear(body)
        break
      case 'turns':
        matches = readAgentJournalTurn(body) !== null && (!selection.root || root)
        break
      case 'users':
        matches = user && (!selection.unknown || item.turnScope?.kind === 'unknown')
        break
      case 'prompt':
        matches = user
        break
      case 'assistant-exists':
        matches = body.kind === 'message' && body.role === 'assistant'
        break
      case 'assistant-prose':
        matches =
          root &&
          body.kind === 'message' &&
          body.role === 'assistant' &&
          body.command === undefined &&
          !!withoutNativeChatVisualDirectiveLines(
            body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
          ).trim()
        break
      case 'pending-prompts':
        matches =
          (body.kind === 'approval' || body.kind === 'question') &&
          body.resolution.state === 'pending'
        break
      case 'scoped-statuses':
        matches =
          body.kind === 'status' &&
          item.turnScope?.kind === 'turn' &&
          item.turnScope.turnItemId === selection.turnItemId
        break
      case 'tools':
        matches =
          root &&
          compareJournalStatusPositions(position, selection.after) > 0 &&
          (selection.running
            ? body.kind === 'tool-call' && body.state === 'running'
            : body.kind === 'tool-call' || body.kind === 'diff')
        break
    }
    if (matches) {
      selected.push({ item, position })
    }
  }
  const ascending =
    selection.kind === 'pending-prompts' ||
    selection.kind === 'scoped-statuses' ||
    (selection.kind === 'turns' && selection.direction === 'asc')
  selected.sort((a, b) => {
    const order =
      selection.kind === 'boundary' && selection.raw
        ? a.position.sequence - b.position.sequence || a.position.ordinal - b.position.ordinal
        : compareJournalStatusPositions(a.position, b.position)
    return ascending ? order : -order
  })
  const single =
    selection.kind === 'boundary' ||
    selection.kind === 'clear' ||
    selection.kind === 'prompt' ||
    selection.kind === 'tools' ||
    selection.kind === 'assistant-exists'
  yield* single ? selected.slice(0, 1) : selected
}
