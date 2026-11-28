import type { CodexRecoveredChat, CodexRecoveryKept } from './codex-shared-recovery-group'
import type { CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerRouter } from './codex-shared-server-router'

/** What a server handed back to its daemon keeps for its next attach: what recovery knew that the
 *  spool can't rebuild (owners, parent links, cuts) and whether unknown loss was seen. No frames. */
export type CodexSharedServerHandedBack = { recovery: CodexRecoveryKept; lossUnknown: boolean }

/**
 * Seeds a reattached server's recovery from its last hand-back, before its expected chats and
 * discovery: each held family keeps its owner, links and cut. A group whose chat no longer names
 * this server (deleted, or a new run) isn't restored.
 */
export function restoreCodexSharedRecovery(
  server: { recovery: CodexSharedServerRecovery; router: CodexSharedServerRouter },
  handedBack: CodexSharedServerHandedBack,
  expected: readonly CodexRecoveredChat[]
): void {
  const { recovery } = server
  const chats = new Map(expected.map((chat) => [chat.sessionId, chat]))
  for (const group of handedBack.recovery.groups) {
    const root = group.threads[0]?.[0]
    const chat = group.chat ? chats.get(group.chat.sessionId) : null
    if (!root || chat === undefined) {
      continue
    }
    if (chat) {
      recovery.expect(chat)
    } else {
      recovery.holdUnowned(root)
    }
    for (const [threadId, parent] of group.threads.slice(1)) {
      if (parent) {
        recovery.join(threadId, parent)
      }
    }
    if (group.cut) {
      recovery.markCut(chat?.threadId ?? root)
    }
  }
  if (handedBack.recovery.cutEverything) {
    recovery.cutFromNowOn()
  }
  if (handedBack.lossUnknown) {
    server.router.noteUnknownLoss()
  }
}
