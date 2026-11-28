// A teammate's chat opens and closes in their own list run one at a time, in call order, each whole
// (its saved row and its live row): under a main-owned layout a save lands later, so a close must
// neither jump ahead of an open still landing nor leave a live row that open projects after it.
import { expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { personWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import type { ChatTabChange } from '../chat/agent-session-tab-layout'
import { PersonChatTabs } from './person-chat-tabs'

const LIST = personWorkspaceKey({
  folderWorkspaceId: 'home',
  botId: 'bot-1',
  accountId: 'usr_mate'
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness() {
  const snapshots = new Map<string, RuntimeMobileSessionTabsSnapshot>()
  const saved = new Set<string>()
  const queued: ChatTabChange[] = []
  const pending: (() => void)[] = []
  const tabs = new PersonChatTabs({
    snapshots: () => snapshots,
    storeSnapshot: (list, snapshot) => (snapshots.set(list, snapshot), snapshot),
    emit: () => {},
    savedLists: () => undefined,
    // Each save lands when the test says, as a main-owned layout queue applies later.
    saveChanges: (_list, changes) => {
      queued.push(...changes)
      return new Promise<void>((resolve) =>
        pending.push(() => {
          for (const change of changes) {
            if ('open' in change) {
              saved.add(change.open.sessionId)
            } else {
              saved.delete(change.close)
            }
          }
          resolve()
        })
      )
    },
    project: (input) =>
      snapshots.set(input.workspaceId, {
        worktree: input.workspaceId,
        publicationEpoch: 'e',
        snapshotVersion: (snapshots.get(input.workspaceId)?.snapshotVersion ?? 0) + 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            type: 'agent-session',
            id: input.rowId ?? input.sessionId,
            title: 'Chat',
            sessionId: input.sessionId,
            agent: input.agent,
            isActive: false
          }
        ]
      }),
    forgetTabs: () => {},
    restored: async () => {},
    agents: () => [],
    closeListTab: () => {}
  })
  const live = () =>
    (snapshots.get(LIST)?.tabs ?? []).flatMap((tab) =>
      tab.type === 'agent-session' ? [tab.sessionId] : []
    )
  const landNext = async () => {
    await tick()
    pending.shift()?.()
    await tick()
  }
  return { tabs, saved, queued, live, landNext }
}

it('runs a close called during an open after it, leaving the chat closed live and saved', async () => {
  const h = harness()
  const opening = h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  let closed = false
  const closing = h.tabs.close(LIST, 's1').then(() => (closed = true))
  await tick()

  // The close waits for the open whole: nothing of it is queued yet.
  expect(h.queued).toMatchObject([{ open: { sessionId: 's1' } }])
  await h.landNext()
  expect(h.queued).toMatchObject([{ open: { sessionId: 's1' } }, { close: 's1' }])
  expect(closed).toBe(false)
  await h.landNext()
  await Promise.all([opening, closing])

  expect(closed).toBe(true)
  expect(h.live()).toEqual([])
  expect([...h.saved]).toEqual([])
})

it('runs an open called during a close after it, leaving the chat open live and saved', async () => {
  const h = harness()
  const first = h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  await h.landNext()
  await first
  const closing = h.tabs.close(LIST, 's1')
  const opening = h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  await h.landNext()
  await h.landNext()
  await Promise.all([closing, opening])

  expect(h.live()).toEqual(['s1'])
  expect([...h.saved]).toEqual(['s1'])
})
