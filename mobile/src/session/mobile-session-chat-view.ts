import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../src/shared/native-chat-agent-support'
import {
  normalizeTerminalChatPair,
  type TerminalChatPair,
  type TerminalTabViewMode
} from '../../../src/shared/terminal-tab-view-mode'
import type { MobileSessionView } from '../storage/session-view-preferences'
import type { MobileSessionParentLayout } from './mobile-session-route-types'
import { terminalLayoutLeafIds } from './mobile-terminal-records'

/** One leaf's view on a host that owns the chat pair; `undecided` waits on a settling input. */
export type MobileLeafView = 'chat' | 'terminal' | 'undecided'

export type MobileNativeChatReadability = 'unknown' | 'readable' | 'unreadable' | 'failed'

export type MobileChatViewRow = {
  type: string
  id: string
  parentTabId?: string
  leafId?: string
  launchAgent?: string | null
  viewMode?: 'terminal' | 'chat'
  parentLayout?: MobileSessionParentLayout
  ptyId?: string | null
  incarnationId?: string | null
}

export type MobileChatViewInputs = {
  defaultView: { value: MobileSessionView; settled: boolean }
  readability: MobileNativeChatReadability
}

export function chatViewParentTabId(row: MobileChatViewRow): string {
  return row.parentTabId ?? row.id
}

export function chatViewLeafId(row: MobileChatViewRow): string {
  return row.leafId ?? row.id
}

/** Which terminal process a row shows; an empty id is unknown, never a new process. */
export type ChatViewProcessFence = { ptyId: string | null; incarnationId: string | null }

export function chatViewProcessFence(row: MobileChatViewRow): ChatViewProcessFence {
  return { ptyId: row.ptyId || null, incarnationId: row.incarnationId || null }
}

/**
 * The one "same terminal process" rule for pending writes and retained identity. Only main-side
 * publishers send an incarnation, so it can appear or vanish when the desktop republishes a leaf;
 * the PTY id decides then. The fence kept carries the last known ids forward.
 */
export function advanceChatViewProcessFence(
  before: ChatViewProcessFence | undefined,
  row: MobileChatViewRow
): { fence: ChatViewProcessFence; changed: boolean } {
  const after = chatViewProcessFence(row)
  if (!before) {
    return { fence: after, changed: false }
  }
  const changed =
    before.incarnationId && after.incarnationId
      ? before.incarnationId !== after.incarnationId
      : Boolean(before.ptyId && after.ptyId && before.ptyId !== after.ptyId)
  if (changed) {
    return { fence: after, changed: true }
  }
  return {
    fence: {
      ptyId: after.ptyId ?? before.ptyId,
      incarnationId: after.incarnationId ?? before.incarnationId
    },
    changed: false
  }
}

/** The parent's leaves: the published tree, else the sibling rows the snapshot carries. */
export function chatViewLeafIds(
  row: MobileChatViewRow,
  rows: readonly MobileChatViewRow[]
): string[] {
  const root = row.parentLayout?.root
  if (root) {
    return terminalLayoutLeafIds(root)
  }
  const parent = chatViewParentTabId(row)
  return rows
    .filter(
      (candidate) => candidate.type === 'terminal' && chatViewParentTabId(candidate) === parent
    )
    .map(chatViewLeafId)
}

export function hostChatPairForRow(row: MobileChatViewRow): TerminalChatPair {
  const chatLeafId = row.parentLayout?.chatLeafId
  return {
    ...(row.viewMode ? { viewMode: row.viewMode } : {}),
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

/**
 * The view of one terminal leaf. `pair` is the pending click, else the accepted host pair, with an
 * ownerless chat already resolved to its display leaf (`ownerlessChatDisplayLeaf`).
 * Live agent status is deliberately not an input: it only decides whether chat is offered.
 */
export function resolveMobileLeafView(
  row: MobileChatViewRow,
  pair: TerminalChatPair,
  leafIds: readonly string[],
  inputs: MobileChatViewInputs
): MobileLeafView {
  const leafId = chatViewLeafId(row)
  // Why the shared rule: an owner outside the tree means its pane closed, so no sibling may claim chat.
  const normalized = normalizeTerminalChatPair(pair, row.parentLayout?.root)
  if (normalized.viewMode === 'chat') {
    return normalized.chatLeafId === leafId ? 'chat' : 'terminal'
  }
  if (normalized.viewMode === 'terminal') {
    return 'terminal'
  }
  // Nobody switched this tab: this device's default, for a sole leaf launched as a supported agent.
  if (leafIds.length !== 1 || leafIds[0] !== leafId) {
    return 'terminal'
  }
  const agent = row.launchAgent ?? null
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return 'terminal'
  }
  if (!inputs.defaultView.settled) {
    return 'undecided'
  }
  if (inputs.defaultView.value !== 'chat') {
    return 'terminal'
  }
  if (nativeChatRequiresLocalTranscript(agent)) {
    switch (inputs.readability) {
      case 'readable':
        return 'chat'
      case 'unknown':
        return 'undecided'
      default:
        return 'terminal'
    }
  }
  return 'chat'
}

/** The absolute pair a switch of `row` to `view` asks the host for. */
export function chatPairTargetForView(
  row: MobileChatViewRow,
  view: TerminalTabViewMode
): TerminalChatPair {
  return view === 'chat'
    ? { viewMode: 'chat', chatLeafId: chatViewLeafId(row) }
    : { viewMode: 'terminal' }
}
