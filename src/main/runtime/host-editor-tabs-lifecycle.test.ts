/**
 * Host-owned editor tabs live in the workspace session the window also restores from: edit tabs
 * survive hydrates and restarts, diffs are transient, and close/activate/move persist one
 * consistent layout.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, getDefaultWorkspaceSession } =
  await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, makeRuntimeStoreWithWorkspaceSession, makeHeadlessTerminalLayout } =
  await import('./orca-runtime-test-fixtures.spec')
const { createHeadlessEditorHarness } = await import('./host-editor-tabs-test-harness.spec')

const LEAF = '11111111-1111-4111-8111-111111111111'

function sessionWithTerminal(worktreeId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: worktreeId,
    activeTabId: 'term-1',
    activeTabIdByWorktree: { [worktreeId]: 'term-1' },
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

type HydratingRuntime = {
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options?: { force?: boolean }
  ): Set<string>
}

// Why: the hydrate is protected; tests drive it the way list/graph-sync callers do.
function hydrate(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  worktreeId: string,
  options?: { force?: boolean }
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every OrcaRuntimeService has this protected hydrate.
  ;(runtime as unknown as HydratingRuntime).hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId,
    options
  )
}

function restart(session: WorkspaceSessionState) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session fixture store implements every store method these headless paths call.
  return new OrcaRuntimeService(runtimeStore as never)
}

describe('host-owned editor tab lifecycle', () => {
  it('keeps an edit tab across forced and non-forced hydrates and a restart', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const opened = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs

    hydrate(runtime, worktreeId, { force: true })
    hydrate(runtime, worktreeId)
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual(opened)

    const restarted = restart(getSession())
    expect((await restarted.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([
      expect.objectContaining({ id: opened[0]!.id, type: 'markdown', relativePath: 'notes.md' })
    ])
  })

  it('lists a document-only worktree in the unscoped inventory', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')

    const all = await restart(getSession()).listAllMobileSessionTabs()

    expect(all.find((snapshot) => snapshot.worktree === worktreeId)?.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'notes.md' })
    ])
  })

  it('keeps a diff tab across hydrates but not across a restart', async () => {
    const { runtime, worktreeId, getSession } = await createHeadlessEditorHarness()
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)

    hydrate(runtime, worktreeId, { force: true })
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([
      expect.objectContaining({ type: 'file', mode: 'diff' })
    ])
    expect((await restart(getSession()).listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
  })

  it('closes an edit tab without writing the file, and hydration cannot resurrect it', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    const filePath = await writeWorktreeFile('notes.md', 'keep me')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const [tab] = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs

    const outcome = await runtime.closeMobileSessionTab(`id:${worktreeId}`, tab!.id)

    expect(outcome).toMatchObject({ closed: true })
    hydrate(runtime, worktreeId, { force: true })
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
    expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([])
    expect(await readFile(filePath, 'utf8')).toBe('keep me')
    expect((await restart(getSession()).listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
  })

  it('closes a diff tab for good', async () => {
    const { runtime, worktreeId } = await createHeadlessEditorHarness()
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', true)
    const [tab] = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, tab!.id)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
  })

  it.each([
    ['a restored draft', 'unsaved words'],
    ['an empty-string draft', '']
  ])('refuses to close %s and keeps it through a restart', async (_label, draft) => {
    const { runtime, worktreeId, getSession } = await createHeadlessEditorHarness(
      (worktreeId, worktreePath) => ({
        ...getDefaultWorkspaceSession(),
        activeRepoId: TEST_REPO_ID,
        activeWorktreeId: worktreeId,
        openFilesByWorktree: {
          [worktreeId]: [
            {
              filePath: `${worktreePath}/notes.md`,
              relativePath: 'notes.md',
              worktreeId,
              language: 'markdown',
              dirtyDraftContent: draft,
              lastKnownDiskSignature: 'sig-1'
            }
          ]
        }
      })
    )
    const [tab] = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs
    expect(tab).toMatchObject({ type: 'markdown', isDirty: true })

    await expect(runtime.closeMobileSessionTab(`id:${worktreeId}`, tab!.id)).rejects.toThrow(
      'This file has unsaved changes on the computer. Open Orca there to save or discard them.'
    )

    expect(getSession().openFilesByWorktree?.[worktreeId]?.[0]).toMatchObject({
      dirtyDraftContent: draft,
      lastKnownDiskSignature: 'sig-1'
    })
    expect((await restart(getSession()).listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([
      expect.objectContaining({ id: tab!.id, isDirty: true })
    ])
  })

  it('records editor activation and hands focus back to a terminal', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(sessionWithTerminal)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the activation path calls only the spawn/write/kill/list methods stubbed here.
    runtime.setPtyController({
      spawn: async () => ({ id: 'serve-pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    } as never)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md', 'caller')
    const before = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const editor = before.tabs.find((tab) => tab.type === 'markdown')!
    expect(editor.isActive).toBe(false)

    await runtime.activateMobileSessionTab(`id:${worktreeId}`, editor.id)

    expect(getSession().activeTabTypeByWorktree?.[worktreeId]).toBe('editor')
    const restartedTabs = (await restart(getSession()).listMobileSessionTabs(`id:${worktreeId}`))
      .tabs
    expect(restartedTabs.find((tab) => tab.isActive)?.id).toBe(editor.id)

    const terminal = before.tabs.find((tab) => tab.type === 'terminal')!
    await runtime.activateMobileSessionTab(`id:${worktreeId}`, terminal.id)
    expect(getSession().activeTabTypeByWorktree?.[worktreeId]).toBe('terminal')
    expect(
      (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find((tab) => tab.isActive)
        ?.type
    ).toBe('terminal')
  })

  it('still activates an editor tab when the host owns no session partition to record it in', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md', 'caller')
    const editor = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs.find(
      (tab) => tab.type === 'markdown'
    )!
    const recorded = getSession()
    Object.assign(runtime, { getOwnWorkspaceSessionForWorktree: () => null })

    const result = await runtime.activateMobileSessionTab(`id:${worktreeId}`, editor.id)

    expect(result.activeTabId).toBe(editor.id)
    expect(getSession()).toBe(recorded)
  })

  it('persists a single-group reorder of mixed terminal and editor tabs', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness(sessionWithTerminal)
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const group = listed.tabGroups![0]!
    const editorId = listed.tabs.find((tab) => tab.type === 'markdown')!.id
    expect(group.tabOrder).toEqual(['term-1', editorId])

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'reorder',
      tabId: editorId,
      targetGroupId: group.id,
      tabOrder: [editorId, 'term-1']
    })

    expect(
      (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabGroups?.[0]?.tabOrder
    ).toEqual([editorId, 'term-1'])
    hydrate(runtime, worktreeId, { force: true })
    expect(
      (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabGroups?.[0]?.tabOrder
    ).toEqual([editorId, 'term-1'])
    expect(
      (await restart(getSession()).listMobileSessionTabs(`id:${worktreeId}`)).tabGroups?.[0]
        ?.tabOrder
    ).toEqual([editorId, 'term-1'])
  })

  it('persists an editor split into its own group with the wrapper following it', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness((worktreeId) => ({
        ...sessionWithTerminal(worktreeId),
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
          [worktreeId]: [{ id: 'g-1', worktreeId, activeTabId: 'term-1', tabOrder: ['term-1'] }]
        },
        activeGroupIdByWorktree: { [worktreeId]: 'g-1' }
      }))
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    const editorId = listed.tabs.find((tab) => tab.type === 'markdown')!.id
    expect(editorId).toMatch(/^[0-9a-f-]{36}$/)

    await runtime.moveMobileSessionTab(`id:${worktreeId}`, {
      kind: 'split',
      tabId: editorId,
      targetGroupId: listed.tabGroups![0]!.id,
      splitDirection: 'right'
    })

    const after = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(after.tabGroups).toHaveLength(2)
    const editorGroup = after.tabGroups!.find((group) => group.tabOrder.includes(editorId))!
    const session = getSession()
    const wrapper = session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === editorId)
    expect(wrapper).toMatchObject({ groupId: editorGroup.id, contentType: 'editor' })
    expect(session.tabGroups?.[worktreeId]?.map((group) => group.tabOrder)).toEqual(
      after.tabGroups!.map((group) => group.tabOrder)
    )
    const restarted = await restart(session).listMobileSessionTabs(`id:${worktreeId}`)
    expect(restarted.tabGroups?.map((group) => group.tabOrder)).toEqual(
      after.tabGroups!.map((group) => group.tabOrder)
    )
  })
})
