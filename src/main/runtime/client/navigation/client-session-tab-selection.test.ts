import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { MobileSessionSnapshotsByWorktree } from '../../session-tabs/publication/mobile-session-snapshots-by-worktree'
import { projectStructuredSessionTab } from '../../session-tabs/chat/structured-session-tab-publication'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'

const WORKTREE = 'wt-1'
const SESSION_ID = 'chat-1'
const CHAT_ID = `agent-session:${SESSION_ID}`

function hostWithSelections() {
  const selections = new ClientSessionTabSelectionStore()
  const runtime = {
    mobileSessionTabsByWorktree: new MobileSessionSnapshotsByWorktree(),
    storeMobileSessionSnapshot(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot) {
      runtime.mobileSessionTabsByWorktree.set(worktreeId, snapshot)
      return snapshot
    },
    reopenClosedMobileSessionTab: (worktreeId: string, tabId: string) =>
      selections.reopenForAllClients(worktreeId, tabId)
  }
  const publishChat = () =>
    projectStructuredSessionTab(
      runtime,
      { workspaceId: WORKTREE, sessionId: SESSION_ID, agent: 'claude', activate: false },
      () => {}
    )
  const frame = (): RuntimeMobileSessionTabsResult => {
    const stored = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    return { ...stored, tabs: stored.tabs.filter((tab) => tab.type === 'agent-session') }
  }
  const shown = (client: string) => selections.project(frame(), client).tabs.map((tab) => tab.id)
  return { selections, runtime, publishChat, frame, shown }
}

describe('closed chat tabs across clients', () => {
  it('shows a reopened chat to a client that missed its close, and hides stale echoes until then', () => {
    const host = hostWithSelections()
    host.publishChat()
    expect(host.shown('phone')).toEqual([CHAT_ID])

    // Closed while a stale frame still lists it: every client keeps it hidden.
    host.selections.forgetTabs(WORKTREE, [CHAT_ID])
    expect(host.shown('phone')).toEqual([])

    // The host drops the row and later reopens the same chat while the phone is away.
    const open = host.frame()
    host.runtime.storeMobileSessionSnapshot(WORKTREE, { ...open, tabs: [], tabGroups: [] })
    host.publishChat()

    expect(host.shown('phone')).toEqual([CHAT_ID])
  })
})
