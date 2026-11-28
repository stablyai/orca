// A teammate's chat opens and closes in their own list take effect in call order, live at once and
// saved in the order issued: under a main-owned layout a save lands later, and nothing waits on it.
import { expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { personWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import type { ChatTabChange } from '../chat/agent-session-tab-layout'
import { PersonChatTabs } from './person-chat-tabs'
import { teammateTabListKey } from '../../../bots/team-share/teammate-rules'

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
    project: (input) => {
      const rows = (snapshots.get(input.workspaceId)?.tabs ?? []).filter(
        (tab) => tab.type !== 'agent-session' || tab.sessionId !== input.sessionId
      )
      snapshots.set(input.workspaceId, {
        worktree: input.workspaceId,
        publicationEpoch: 'e',
        snapshotVersion: (snapshots.get(input.workspaceId)?.snapshotVersion ?? 0) + 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          ...rows,
          {
            type: 'agent-session',
            id: input.rowId ?? input.sessionId,
            title: 'Chat',
            sessionId: input.sessionId,
            agent: input.agent,
            isActive: false
          }
        ]
      })
    },
    forgetTabs: () => {},
    restoring: () => {},
    agents: () => [{ id: 'bot-1', folderWorkspaceId: 'home' }],
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

it('closes a chat opened just before, live at once and saved in call order', async () => {
  const h = harness()
  const opening = h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  expect(h.live()).toEqual(['s1'])
  const closing = h.tabs.close(LIST, 's1')

  expect(h.live()).toEqual([])
  expect(h.queued).toMatchObject([{ open: { sessionId: 's1' } }, { close: 's1' }])
  await h.landNext()
  await h.landNext()
  await Promise.all([opening, closing])
  expect([...h.saved]).toEqual([])
})

it('opens a chat closed just before, live at once and saved in call order', async () => {
  const h = harness()
  void h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  void h.tabs.close(LIST, 's1')
  void h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })

  expect(h.live()).toEqual(['s1'])
  await h.landNext()
  await h.landNext()
  await h.landNext()
  expect([...h.saved]).toEqual(['s1'])
})

it('closes a teammate’s tab for a chat whose open is still saving', async () => {
  const h = harness()
  void h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  const person = teammateTabListKey({ botId: 'bot-1', accountId: 'usr_mate' })

  const closing = h.tabs.closeTeammateTab(person, 'folder:home', 'agent-session:s1', {})

  expect(h.live()).toEqual([])
  await h.landNext()
  await h.landNext()
  expect(await closing).toMatchObject({ closed: true, retirementConfirmed: true })
  expect(h.live()).toEqual([])
  expect(h.queued).toMatchObject([{ open: { sessionId: 's1' } }, { close: 's1' }])
})

it('never holds one write behind a save that does not land', () => {
  const h = harness()
  void h.tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  void h.tabs.open(LIST, { sessionId: 's2', agent: 'codex', activate: true })
  void h.tabs.close(LIST, 's2')

  // No save has landed; every write is live and issued.
  expect(h.live()).toEqual(['s1'])
  expect(h.queued).toHaveLength(3)
})
