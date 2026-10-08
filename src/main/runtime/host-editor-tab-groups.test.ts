/**
 * With no window, a unified session's groups are the only group model: phones see the window's
 * groups (terminals included), a phone move persists them unchanged, and a transient diff's focus
 * never reaches the persisted session.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { getDefaultWorkspaceSession } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, makeHeadlessTerminalLayout } =
  await import('./orca-runtime-test-fixtures.spec')
const { createHeadlessEditorHarness } = await import('./host-editor-tabs-test-harness.spec')

const LEAF = '11111111-1111-4111-8111-111111111111'

function legacySessionWithTerminal(worktreeId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: worktreeId,
    activeTabId: 'term-1',
    activeTabIdByWorktree: { [worktreeId]: 'term-1' },
    activeTabTypeByWorktree: { [worktreeId]: 'terminal' },
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: 'term-1',
          ptyId: null,
          worktreeId,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { 'term-1': makeHeadlessTerminalLayout({ [LEAF]: undefined }) }
  }
}

/** What a desktop window persists for one terminal in one group, before it closes. */
function unifiedSessionWithTerminal(worktreeId: string): WorkspaceSessionState {
  return {
    ...legacySessionWithTerminal(worktreeId),
    unifiedTabs: {
      [worktreeId]: [
        {
          id: 'term-1',
          entityId: 'term-1',
          groupId: 'g-1',
          worktreeId,
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [worktreeId]: [
        {
          id: 'g-1',
          worktreeId,
          activeTabId: 'term-1',
          tabOrder: ['term-1'],
          recentTabIds: ['term-1']
        }
      ]
    },
    tabGroupLayouts: { [worktreeId]: { type: 'leaf', groupId: 'g-1' } },
    activeGroupIdByWorktree: { [worktreeId]: 'g-1' }
  }
}

function sessionIds(session: WorkspaceSessionState): string {
  return JSON.stringify(session)
}

describe('host editor tabs in a unified session', () => {
  it('shows and persists the one group the window had', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(unifiedSessionWithTerminal)
    await writeWorktreeFile('notes.md', 'a')
    await writeWorktreeFile('b.md', 'b')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    await runtime.openMobileFile(`id:${worktreeId}`, 'b.md')
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const [notes, b] = listed.tabs.filter((tab) => tab.type === 'markdown')
    expect(listed.tabGroups).toEqual([
      expect.objectContaining({ id: 'g-1', tabOrder: ['term-1', notes!.id, b!.id] })
    ])

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'reorder',
      tabId: b!.id,
      targetGroupId: 'g-1',
      tabOrder: [b!.id, 'term-1', notes!.id]
    })

    const session = getSession()
    expect(session.tabGroups?.[worktreeId]).toEqual([
      expect.objectContaining({ id: 'g-1', tabOrder: [b!.id, 'term-1', notes!.id] })
    ])
    expect(session.tabGroupLayouts?.[worktreeId]).toEqual({ type: 'leaf', groupId: 'g-1' })
    expect(session.unifiedTabs?.[worktreeId]?.map((tab) => tab.groupId)).toEqual([
      'g-1',
      'g-1',
      'g-1'
    ])
    expect(sessionIds(session)).not.toContain('headless-terminals:')
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabGroups).toEqual([
      expect.objectContaining({ id: 'g-1', tabOrder: [b!.id, 'term-1', notes!.id] })
    ])
  })

  it('still splits an editor into its own group and moves a terminal across groups', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(unifiedSessionWithTerminal)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const notes = listed.tabs.find((tab) => tab.type === 'markdown')!

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'split',
      tabId: notes.id,
      targetGroupId: 'g-1',
      splitDirection: 'right'
    })
    const split = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const editorGroup = split.tabGroups!.find((group) => group.tabOrder.includes(notes.id))!
    expect(split.tabGroups!.map((group) => group.id)).toEqual(['g-1', editorGroup.id])

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'move-to-group',
      tabId: split.tabs.find((tab) => tab.type === 'terminal')!.id,
      targetGroupId: editorGroup.id
    })

    const session = getSession()
    const terminalWrapper = session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === 'term-1')
    expect(terminalWrapper?.groupId).toBe(editorGroup.id)
    expect(session.tabGroups?.[worktreeId]?.flatMap((group) => group.tabOrder).sort()).toEqual(
      ['term-1', notes.id].sort()
    )
    expect(sessionIds(session)).not.toContain('headless-terminals:')
  })
})

describe('transient diff focus', () => {
  it('is never persisted, and closing the diff returns to the previous editor', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(unifiedSessionWithTerminal)
    await writeWorktreeFile('notes.md', 'a')
    await writeWorktreeFile('other.md', 'b')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    await runtime.openMobileFile(`id:${worktreeId}`, 'other.md')
    const durable = structuredClone(getSession())
    const other = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find(
      (tab) => tab.type === 'markdown' && tab.relativePath === 'other.md'
    )!

    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)
    const withDiff = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const diff = withDiff.tabs.find((tab) => tab.type === 'file' && tab.mode === 'diff')!
    expect(withDiff.activeTabId).toBe(diff.id)
    expect(getSession()).toEqual(durable)

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, diff.id)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).activeTabId).toBe(other.id)
    expect(getSession()).toEqual(durable)
  })

  it('closing a diff opened over a terminal returns to the terminal', async () => {
    const { runtime, worktreeId, getSession } =
      await createHeadlessEditorHarness(legacySessionWithTerminal)
    const terminal = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs[0]!
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)
    const diff = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find(
      (tab) => tab.type === 'file'
    )!

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, diff.id)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).activeTabId).toBe(terminal.id)
    expect(getSession().activeFileIdByWorktree?.[worktreeId] ?? null).toBeNull()
    expect(getSession().activeTabTypeByWorktree?.[worktreeId]).toBe('terminal')
  })

  it('closing the diff returns to a terminal the phone focused after an editor', async () => {
    const { runtime, worktreeId, writeWorktreeFile } = await createHeadlessEditorHarness(
      unifiedSessionWithTerminal
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the activation path calls only the spawn/write/kill/list methods stubbed here.
    runtime.setPtyController({
      spawn: async () => ({ id: 'serve-pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    } as never)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const terminal = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find(
      (tab) => tab.type === 'terminal'
    )!
    await runtime.activateMobileSessionTab(`id:${worktreeId}`, terminal.id)
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)
    const diff = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find(
      (tab) => tab.type === 'file'
    )!

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, diff.id)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).activeTabId).toBe(terminal.id)
  })

  it('a phone move with a diff open persists no diff id', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(unifiedSessionWithTerminal)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const diff = listed.tabs.find((tab) => tab.type === 'file')!
    const order = listed.tabGroups![0]!.tabOrder

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'reorder',
      tabId: diff.id,
      targetGroupId: 'g-1',
      tabOrder: [diff.id, ...order.filter((id) => id !== diff.id)]
    })

    expect(sessionIds(getSession())).not.toContain(diff.id)
    expect(
      (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabGroups?.[0]?.tabOrder[0]
    ).toBe(diff.id)
  })
})

describe.each([
  ['legacy', legacySessionWithTerminal],
  ['unified', unifiedSessionWithTerminal]
] as const)('closing the focused editor in a %s session', (_label, initialSession) => {
  it('focuses the terminal the group used last instead of nothing', async () => {
    const { runtime, worktreeId, writeWorktreeFile } =
      await createHeadlessEditorHarness(initialSession)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const notes = listed.tabs.find((tab) => tab.type === 'markdown')!
    const terminal = listed.tabs.find((tab) => tab.type === 'terminal')!
    expect(listed.activeTabId).toBe(notes.id)

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, notes.id)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).activeTabId).toBe(terminal.id)
  })
})
