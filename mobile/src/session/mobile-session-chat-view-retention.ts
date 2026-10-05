import { nativeChatRequiresLocalTranscript } from '../../../src/shared/native-chat-agent-support'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import {
  advanceChatViewProcessFence,
  chatViewLeafId,
  chatViewLeafIds,
  chatViewParentTabId,
  type ChatViewProcessFence,
  type MobileChatViewRow,
  type MobileNativeChatReadability
} from './mobile-session-chat-view'
import {
  ownerlessChatDisplayLeaf,
  type OwnerlessChatPlacement
} from '../../../src/shared/native-chat-owner-pick'

export type RetainedChatViewRow = {
  fence: ChatViewProcessFence
  identity: MobileNativeChatResolution | null
}

/** What one session route remembers between accepted snapshots of its host and worktree. */
export type ChatViewRetention = {
  /** Per row: the last transcript identity seen behind its current terminal process. */
  rows: ReadonlyMap<string, RetainedChatViewRow>
  /** Rows whose terminal process changed since the previous snapshot. */
  processChanged: ReadonlySet<string>
  /** Parent tab id -> where its ownerless chat shows. */
  ownerlessChatLeaves: ReadonlyMap<string, OwnerlessChatPlacement>
}

export const EMPTY_CHAT_VIEW_RETENTION: ChatViewRetention = {
  rows: new Map(),
  processChanged: new Set(),
  ownerlessChatLeaves: new Map()
}

/** Keeps the last identity through a status lapse, and a session id the next status omits. */
function retainIdentity(
  previous: MobileNativeChatResolution | null,
  current: MobileNativeChatResolution | null
): MobileNativeChatResolution | null {
  if (!current) {
    return previous
  }
  if (previous && previous.agent === current.agent && !current.sessionId && previous.sessionId) {
    return {
      ...current,
      sessionId: previous.sessionId,
      transcriptPath: current.transcriptPath ?? previous.transcriptPath
    }
  }
  return current
}

function isOwnerlessChat(pair: TerminalChatPair | null): boolean {
  return pair?.viewMode === 'chat' && !pair.chatLeafId
}

/** Whether a row can show chat on live evidence alone, like the desktop's claim check. */
function canShowChatNow(
  row: MobileNativeChatTab,
  readability: MobileNativeChatReadability
): boolean | 'unknown' {
  const ifReadable = resolveMobileNativeChat(row, true)
  if (!ifReadable || !nativeChatRequiresLocalTranscript(ifReadable.agent)) {
    return ifReadable !== null
  }
  return readability === 'unknown' ? 'unknown' : readability === 'readable'
}

/**
 * Re-derives the retention from the previous one and the latest rows. Entries die with their row,
 * on a new terminal process, or (ownerless chat) once neither the host nor a pending reply holds
 * an ownerless chat; a pending switch to a named view never erases where it shows.
 */
export function advanceChatViewRetention(
  previous: ChatViewRetention,
  args: {
    rows: readonly (MobileChatViewRow & MobileNativeChatTab)[]
    readability: MobileNativeChatReadability
    hostPairFor: (row: MobileChatViewRow) => TerminalChatPair
    pendingPairFor: (row: MobileChatViewRow) => TerminalChatPair | null
  }
): ChatViewRetention {
  const rows = new Map<string, RetainedChatViewRow>()
  const processChanged = new Set<string>()
  const rowByLeaf = new Map<string, MobileNativeChatTab>()
  for (const row of args.rows) {
    const before = previous.rows.get(row.id)
    const { fence, changed } = advanceChatViewProcessFence(before?.fence, row)
    if (changed) {
      processChanged.add(row.id)
    }
    const kept = changed ? null : (before?.identity ?? null)
    const current = resolveMobileNativeChat(row, args.readability === 'readable')
    rows.set(row.id, { fence, identity: retainIdentity(kept, current) })
    rowByLeaf.set(`${chatViewParentTabId(row)}\0${chatViewLeafId(row)}`, row)
  }
  const ownerlessChatLeaves = new Map<string, OwnerlessChatPlacement>()
  const seenParents = new Set<string>()
  for (const row of args.rows) {
    const parent = chatViewParentTabId(row)
    if (seenParents.has(parent)) {
      continue
    }
    seenParents.add(parent)
    if (!isOwnerlessChat(args.hostPairFor(row)) && !isOwnerlessChat(args.pendingPairFor(row))) {
      continue
    }
    const shown = previous.ownerlessChatLeaves.get(parent)
    const placement = ownerlessChatDisplayLeaf({
      shown: shown?.settled ? shown.leafId : null,
      leafIds: chatViewLeafIds(row, args.rows),
      activeLeafId: row.parentLayout?.activeLeafId,
      // Why live evidence: a retained identity outlives an exited agent on the same shell.
      canShowChat: (leafId) => {
        const leafRow = rowByLeaf.get(`${parent}\0${leafId}`)
        return leafRow ? canShowChatNow(leafRow, args.readability) : false
      }
    })
    if (placement) {
      ownerlessChatLeaves.set(parent, placement)
    }
  }
  return { rows, processChanged, ownerlessChatLeaves }
}
