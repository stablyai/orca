/**
 * A remote move in a worktree with host editor tabs edits the unified session's persisted groups:
 * members the headless snapshot cannot show (a chat, a closed browser page) keep their group and
 * the window's split, and no snapshot-only id is ever written into a group order.
 */
import { describe, expect, it } from 'vitest'
import type { Tab, TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { getDefaultWorkspaceSession } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, makeHeadlessTerminalLayout } =
  await import('./orca-runtime-test-fixtures.spec')
const { createHeadlessEditorHarness } = await import('./host-editor-tabs-test-harness.spec')
const { getHostEditorTabState } = await import('./host-editor-tab-state')

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

const SPLIT: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  first: { type: 'leaf', groupId: 'g-1' },
  second: { type: 'leaf', groupId: 'g-2' }
}

function wrapper(
  worktreeId: string,
  id: string,
  groupId: string,
  contentType: Tab['contentType'],
  entityId = id
): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function terminalRow(worktreeId: string, id: string, sortOrder: number) {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

/** A window's split with the right-hand group holding one tab of `kind`, before it closed. */
function splitSession(kind: 'browser' | 'agent-session') {
  return (worktreeId: string): WorkspaceSessionState => {
    const right =
      kind === 'browser'
        ? wrapper(worktreeId, 'br-1', 'g-2', 'browser', 'browser-ws-1')
        : wrapper(worktreeId, 'structured-agent-session-S1', 'g-2', 'agent-session', 'S1')
    return {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: worktreeId,
      tabsByWorktree: { [worktreeId]: [terminalRow(worktreeId, 'term-1', 0)] },
      terminalLayoutsByTabId: { 'term-1': makeHeadlessTerminalLayout({ [LEAF_1]: undefined }) },
      unifiedTabs: { [worktreeId]: [wrapper(worktreeId, 'term-1', 'g-1', 'terminal'), right] },
      tabGroups: {
        [worktreeId]: [
          { id: 'g-1', worktreeId, activeTabId: 'term-1', tabOrder: ['term-1'] },
          { id: 'g-2', worktreeId, activeTabId: right.id, tabOrder: [right.id] }
        ]
      },
      tabGroupLayouts: { [worktreeId]: SPLIT },
      activeGroupIdByWorktree: { [worktreeId]: 'g-1' }
    }
  }
}

function expectConsistentGroups(session: WorkspaceSessionState, worktreeId: string): void {
  const groups = session.tabGroups?.[worktreeId] ?? []
  const orderIds = groups.flatMap((group) => group.tabOrder)
  expect(orderIds.filter((id) => id.startsWith('agent-session:'))).toEqual([])
  expect(JSON.stringify(session)).not.toContain('headless-terminals:')
  for (const tab of session.unifiedTabs?.[worktreeId] ?? []) {
    const group = groups.find((candidate) => candidate.tabOrder.includes(tab.id))
    expect(group?.id, tab.id).toBe(tab.groupId)
    expect(tab.sortOrder, tab.id).toBe(group!.tabOrder.indexOf(tab.id))
  }
}

describe('a remote move with a split the host cannot fully show', () => {
  it.each([
    ['a closed browser page', 'browser', false],
    ['a chat that is not running', 'agent-session', false],
    ['a running chat', 'agent-session', true]
  ] as const)('keeps the split holding %s after a reorder', async (_name, kind, chatRunning) => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(splitSession(kind))
    const selector = `id:${worktreeId}`
    await runtime.listMobileSessionTabs(selector)
    if (chatRunning) {
      runtime.projectStructuredAgentSessionTab({
        workspaceId: worktreeId,
        sessionId: 'S1',
        agent: 'claude',
        activate: false
      })
    }
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(selector, 'notes.md')
    const listed = await runtime.listMobileSessionTabs(selector)
    const notes = listed.tabs.find((tab) => tab.type === 'markdown')!
    if (chatRunning) {
      expect(listed.tabGroups).toEqual([
        expect.objectContaining({ id: 'g-1', tabOrder: ['term-1', notes.id] }),
        expect.objectContaining({ id: 'g-2', tabOrder: ['agent-session:S1'] })
      ])
    }

    await runtime.moveMobileSessionTab(selector, {
      kind: 'reorder',
      tabId: notes.id,
      targetGroupId: 'g-1',
      tabOrder: [notes.id, 'term-1']
    })

    const session = getSession()
    const right = kind === 'browser' ? 'br-1' : 'structured-agent-session-S1'
    expect(session.tabGroups?.[worktreeId]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', [notes.id, 'term-1']],
      ['g-2', [right]]
    ])
    expect(session.tabGroupLayouts?.[worktreeId]).toEqual(SPLIT)
    expectConsistentGroups(session, worktreeId)
  })

  it('splits an editor off and moves it back without losing the hidden group', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(splitSession('browser'))
    const selector = `id:${worktreeId}`
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(selector, 'notes.md')
    const notes = (await runtime.listMobileSessionTabs(selector)).tabs.find(
      (tab) => tab.type === 'markdown'
    )!

    await runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: notes.id,
      targetGroupId: 'g-1',
      splitDirection: 'down'
    })
    const split = getSession()
    const editorGroup = split.tabGroups?.[worktreeId]?.find(
      (group) => !['g-1', 'g-2'].includes(group.id)
    )
    expect(split.tabGroups?.[worktreeId]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', ['term-1']],
      ['g-2', ['br-1']],
      [editorGroup!.id, [expect.any(String)]]
    ])
    expect(split.tabGroupLayouts?.[worktreeId]).toEqual({
      ...SPLIT,
      first: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'g-1' },
        second: { type: 'leaf', groupId: editorGroup!.id }
      }
    })
    expectConsistentGroups(split, worktreeId)

    await runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: notes.id,
      targetGroupId: 'g-1',
      index: 0
    })
    const moved = getSession()
    expect(moved.tabGroups?.[worktreeId]?.map((group) => group.id)).toEqual(['g-1', 'g-2'])
    expect(moved.tabGroups?.[worktreeId]?.[0]?.tabOrder).toHaveLength(2)
    expect(moved.tabGroupLayouts?.[worktreeId]).toEqual(SPLIT)
    expectConsistentGroups(moved, worktreeId)
  })
})

describe('a session holding the headless terminal group from an earlier split', () => {
  it('moves an editor into the other group in the session, its wrapper and the clients', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness((id) => ({
        ...getDefaultWorkspaceSession(),
        activeRepoId: TEST_REPO_ID,
        activeWorktreeId: id,
        tabsByWorktree: { [id]: [terminalRow(id, 'term-1', 0), terminalRow(id, 'term-2', 1)] },
        terminalLayoutsByTabId: {
          'term-1': makeHeadlessTerminalLayout({ [LEAF_1]: undefined }),
          'term-2': makeHeadlessTerminalLayout({ [LEAF_2]: undefined })
        },
        unifiedTabs: {
          [id]: [wrapper(id, 'term-1', 'g-1', 'terminal'), wrapper(id, 'term-2', 'g-1', 'terminal')]
        },
        tabGroups: {
          [id]: [
            { id: 'g-1', worktreeId: id, activeTabId: 'term-1', tabOrder: ['term-1', 'term-2'] }
          ]
        },
        tabGroupLayouts: { [id]: { type: 'leaf', groupId: 'g-1' } },
        activeGroupIdByWorktree: { [id]: 'g-1' }
      }))
    const selector = `id:${worktreeId}`
    const terminalOnly = await runtime.listMobileSessionTabs(selector)
    const term2 = terminalOnly.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'term-2'
    )!
    await runtime.moveMobileSessionTab(selector, {
      kind: 'split',
      tabId: term2.id,
      targetGroupId: terminalOnly.tabGroups![0]!.id,
      splitDirection: 'right'
    })
    const other = getSession().tabGroups?.[worktreeId]?.find((group) =>
      group.tabOrder.includes('term-2')
    )
    expect(getSession().tabGroups?.[worktreeId]?.[0]?.id).toBe(`headless-terminals:${worktreeId}`)

    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(selector, 'notes.md')
    const notes = (await runtime.listMobileSessionTabs(selector)).tabs.find(
      (tab) => tab.type === 'markdown'
    )!
    await runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: notes.id,
      targetGroupId: other!.id
    })

    const session = getSession()
    const notesWrapper = session.unifiedTabs?.[worktreeId]?.find(
      (tab) => tab.contentType === 'editor'
    )
    expect(notesWrapper?.groupId).toBe(other!.id)
    expect(
      session.tabGroups?.[worktreeId]?.find((group) => group.id === other!.id)?.tabOrder
    ).toEqual(['term-2', notesWrapper!.id])
    const clientGroups = (await runtime.listMobileSessionTabs(selector)).tabGroups
    expect(clientGroups?.find((group) => group.tabOrder.includes(notes.id))?.id).toBe(other!.id)
  })
})

describe('a chat replaced by /clear while the window is closed', () => {
  async function replacedChatHarness() {
    const harness = await createHeadlessEditorHarness(splitSession('agent-session'))
    await harness.writeWorktreeFile('notes.md', 'a')
    await harness.runtime.openMobileFile(`id:${harness.worktreeId}`, 'notes.md')
    return harness
  }

  it('places the replacement chat in its wrapper group when its snapshot is rebuilt', async () => {
    const { runtime, worktreeId } = await replacedChatHarness()
    // No prior S1 tab, so the replacement is projected fresh, as on a cold start.
    runtime.replaceStructuredAgentSessionTab({
      sourceSessionId: 'S1',
      sessionId: 'S2',
      workspaceId: worktreeId,
      agent: 'claude'
    })

    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabGroups?.find((group) => group.id === 'g-2')?.tabOrder).toEqual([
      'agent-session:S2'
    ])
  })

  it('persists a remote move of the replacement chat into the other group', async () => {
    const { runtime, worktreeId, getSession } = await replacedChatHarness()
    const selector = `id:${worktreeId}`
    runtime.projectStructuredAgentSessionTab({
      workspaceId: worktreeId,
      sessionId: 'S1',
      agent: 'claude',
      activate: false
    })
    runtime.replaceStructuredAgentSessionTab({
      sourceSessionId: 'S1',
      sessionId: 'S2',
      workspaceId: worktreeId,
      agent: 'claude'
    })

    await runtime.moveMobileSessionTab(selector, {
      kind: 'move-to-group',
      tabId: 'agent-session:S2',
      targetGroupId: 'g-1'
    })

    const client = await runtime.listMobileSessionTabs(selector)
    const notes = client.tabs.find((tab) => tab.type === 'markdown')!
    expect(client.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', ['term-1', notes.id, 'agent-session:S2']]
    ])
    const session = getSession()
    expect(session.tabGroups?.[worktreeId]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g-1', ['term-1', expect.any(String), 'structured-agent-session-S1']]
    ])
    expect(session.tabGroupLayouts?.[worktreeId]).toEqual({ type: 'leaf', groupId: 'g-1' })
    expectConsistentGroups(session, worktreeId)
  })
})

describe('a remote split of a diff the session cannot persist', () => {
  it('refuses the split instead of showing a group the next list drops', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(splitSession('browser'))
    const selector = `id:${worktreeId}`
    await writeWorktreeFile('notes.md', 'a')
    await writeWorktreeFile('src/a.ts', 'a')
    await runtime.openMobileFile(selector, 'notes.md')
    await runtime.openMobileDiff(selector, 'src/a.ts', false)
    const before = await runtime.listMobileSessionTabs(selector)
    const sessionBefore = getSession()
    const diff = before.tabs.find((tab) => tab.type === 'file')!

    await expect(
      runtime.moveMobileSessionTab(selector, {
        kind: 'split',
        tabId: diff.id,
        targetGroupId: 'g-1',
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })

    const after = await runtime.listMobileSessionTabs(selector)
    expect(after.tabGroups).toEqual(before.tabGroups)
    expect(after.tabGroupLayout).toEqual(before.tabGroupLayout)
    expect(getSession()).toEqual(sessionBefore)
    expect(getHostEditorTabState(runtime).listDiffs(worktreeId)).toEqual([
      expect.objectContaining({ tabId: diff.id, groupId: 'g-1' })
    ])
  })
})
