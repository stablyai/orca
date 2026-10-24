import { withRuntimePaneAdmission } from './runtime-durable-store-fixture'
import { addWorkspace } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { withChatTabChanges } from './agent-session-tab-layout'
import { observeSessionTabPlacementWork } from '../../shared/session-tab-placement-work.test-fixture'
import * as profile from './profile-session-store.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID: WT } = await import('./orca-runtime-test-fixtures.spec')

afterEach(() => vi.restoreAllMocks())

it.each([
  { only: false, pinned: false, retire: true, n: 0 },
  { only: true, pinned: false, retire: true, n: 0 },
  { only: false, pinned: true, retire: true, n: 0 },
  { only: false, pinned: true, retire: false, n: 0 },
  ...[32, 320].map((n) => ({ only: false, pinned: false, retire: true, n }))
])(
  'preserves current headless placement and pin partitions ($only/$pinned/$retire/$n)',
  async ({ only, pinned, retire, n }) => {
    const runtimeStore: typeof store & Parameters<typeof withRuntimePaneAdmission>[0] = { ...store }
    profile.announceSessionWrites(runtimeStore)
    const session = profile.asProfileSessionStore(runtimeStore, 'local')
    withRuntimePaneAdmission(runtimeStore)
    const runtime = new OrcaRuntimeService(runtimeStore)
    const [A, C, B, U, D] = ['A', 'C', 'B', 'U', 'D'].map((id) => `agent-session:${id}`)
    const chat = (id: string) => ({
      type: 'agent-session' as const,
      id,
      sessionId: id.slice(14),
      agent: 'codex' as const,
      title: id,
      isActive: false,
      isPinned: pinned && [A, C, B].includes(id)
    })
    const source = n
      ? Array.from({ length: n }, (_, i) => (i === n / 2 ? C : `agent-session:old-${i}`))
      : only
        ? [C]
        : pinned
          ? [A, C, B, U]
          : [A, C, B]
    const current = Array.from({ length: n }, (_, i) => `agent-session:current-${i}`)
    const work = observeSessionTabPlacementWork()
    const snapshot = (left = source, snapshotVersion = 1): RuntimeMobileSessionTabsSnapshot => ({
      worktree: WT,
      publicationEpoch: 'headless:test',
      snapshotVersion,
      activeGroupId: 'R',
      activeTabId: D,
      activeTabType: 'agent-session',
      tabs: [...left, D].map(chat),
      tabGroups: [
        { id: 'L', activeTabId: left.includes(C) ? C : left[0], tabOrder: left },
        { id: 'R', activeTabId: D, tabOrder: [D] }
      ]
    })
    const savedChat = (id: string) => ({
      id,
      entityId: chat(id).sessionId,
      kind: 'agent-session' as const,
      entry: { agentSessionAgent: 'codex' as const, isPinned: chat(id).isPinned }
    })
    const saved = addWorkspace(session.get('local'), WT, [
      { id: 'L', tabs: source.map(savedChat), activeTabId: C },
      { id: 'R', tabs: [savedChat(D)] }
    ])
    saved.activeGroupIdByWorktree![WT] = 'R'
    session.set(saved, 'local')
    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot()] })
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        const closed = (n ? source : retire ? [C] : []).map(chat)
        const changed = withChatTabChanges('local', session.get('local'), WT, [
          ...current.map((id, i) => ({
            open: {
              sessionId: chat(id).sessionId,
              agent: 'codex' as const,
              tabId: id,
              placement: { groupId: 'L', afterTabId: source[i] }
            }
          })),
          ...closed.map(({ sessionId: close }) => ({ close }))
        ])
        if (changed) {
          session.set(changed, 'local')
        }
        for (const { sessionId } of closed) {
          expect(runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)).toBe(true)
        }
        if (n) {
          runtime.syncWindowGraph(0, {
            tabs: [],
            leaves: [],
            mobileSessionTabs: [snapshot(current, n + 2)]
          })
        }
        await runtime.publishStructuredAgentSessionTab({
          workspaceId: WT,
          sessionId: 'concurrent',
          agent: 'codex',
          activate: false
        })
        return { id: 'pty-placement', incarnationId: '45454545-4545-4545-8545-454545454545' }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createMobileSessionTerminal(`id:${WT}`, {
      afterTabId: C,
      targetGroupId: 'L',
      command: 'codex resume conversation',
      activate: false
    })
    const result = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(result.tabs.some((tab) => tab.id === C)).toBe(!retire)
    expect(
      result.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === 'concurrent')
    ).toBe(true)
    if (!only) {
      expect(result.tabGroups?.find((group) => group.id === 'L')?.tabOrder).toEqual(
        n
          ? [...current.slice(0, n / 2 + 1), created.tab.parentTabId, ...current.slice(n / 2 + 1)]
          : pinned
            ? [A, ...(!retire ? [C] : []), B, created.tab.parentTabId, U]
            : [A, created.tab.parentTabId, B]
      )
      expect(result.tabGroups?.find((group) => group.id === 'R')?.tabOrder).toContain(D)
    } else {
      expect(
        result.tabGroups?.some((group) => group.tabOrder.includes(created.tab.parentTabId))
      ).toBe(true)
    }
    const refreshed = await runtime.listMobileSessionTabs(`id:${WT}`)
    expect(refreshed.tabGroups).toEqual(result.tabGroups)
    if (n) {
      console.info('HOST_PLACEMENT_WORK', JSON.stringify({ n, samples: work.samples }))
      expect(work.samples.length).toBeGreaterThan(0)
      for (const sample of work.samples) {
        expect(sample.reads + sample.adds + sample.has).toBeLessThanOrEqual(12 * n + 32)
      }
    }
  }
)
