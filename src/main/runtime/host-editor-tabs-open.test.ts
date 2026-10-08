/**
 * With no desktop window (`orca serve`, or a desktop whose window is closed), the host owns editor
 * tabs: files.open / files.openDiff publish a session tab before they reply.
 */
import { describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { getDefaultWorkspaceSession } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_WINDOW_ID } = await import('./orca-runtime-test-fixtures.spec')
const { attachEditorWindow, createHeadlessEditorHarness, detachEditorWindow } =
  await import('./host-editor-tabs-test-harness.spec')

describe('host-owned editor tabs with no desktop window', () => {
  it('opens Markdown and source files as session tabs before replying', async () => {
    const { runtime, worktreeId, worktreePath, writeWorktreeFile } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('docs/notes.md', '# Notes\n')
    await writeWorktreeFile('src/app.ts', 'export {}\n')

    const markdown = await runtime.openMobileFile(`id:${worktreeId}`, 'docs/notes.md')
    const source = await runtime.openMobileFile(`id:${worktreeId}`, 'src/app.ts')

    expect(markdown).toMatchObject({ opened: true, kind: 'markdown' })
    expect(source).toMatchObject({ opened: true, kind: 'text' })
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'markdown',
        filePath: `${worktreePath}/docs/notes.md`,
        relativePath: 'docs/notes.md',
        mode: 'edit',
        isDirty: false,
        sourceFileId: `${worktreePath}/docs/notes.md`,
        documentVersion: `file:${worktreePath}/docs/notes.md`,
        isActive: false
      }),
      expect.objectContaining({
        type: 'file',
        relativePath: 'src/app.ts',
        language: 'typescript',
        mode: 'edit',
        isActive: true
      })
    ])
    expect(listed.activeTabType).toBe('file')
    expect(listed.tabGroups?.[0]?.tabOrder).toEqual(listed.tabs.map((tab) => tab.id))
  })

  it('dedupes a repeated open onto the existing tab', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')

    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs).toHaveLength(1)
    expect(getSession().openFilesByWorktree?.[worktreeId]).toHaveLength(1)
  })

  it('still fails a missing path instead of opening a ghost tab', async () => {
    const { runtime, worktreeId } = await createHeadlessEditorHarness()

    await expect(runtime.openMobileFile(`id:${worktreeId}`, 'missing.md')).rejects.toThrow(/ENOENT/)
    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs).toEqual([])
  })

  it('opens staged, unstaged and deleted-file diffs as transient diff tabs', async () => {
    const { runtime, worktreeId, getSession, writeWorktreeFile } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('src/a.ts', 'a')

    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', true)
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)
    // Why no file on disk: a deletion's diff must still open.
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/gone.ts', false)

    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs).toEqual([
      expect.objectContaining({ type: 'file', mode: 'diff', diffSource: 'staged' }),
      expect.objectContaining({ type: 'file', mode: 'diff', diffSource: 'unstaged' }),
      expect.objectContaining({
        type: 'file',
        mode: 'diff',
        diffSource: 'unstaged',
        relativePath: 'src/gone.ts',
        isActive: true
      })
    ])
    // Why: diffs are transient by the session contract and never persisted.
    expect(getSession().openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
  })

  it("does not move other clients' or the host's focus for a caller-only open", async () => {
    const { runtime, worktreeId, writeWorktreeFile } = await createHeadlessEditorHarness()
    await writeWorktreeFile('first.md', 'a')
    await writeWorktreeFile('second.md', 'b')
    await runtime.openMobileFile(`id:${worktreeId}`, 'first.md')
    const other = vi.fn()
    runtime.onMobileSessionTabsChanged(other, 'other-phone')

    await runtime.openMobileFile(`id:${worktreeId}`, 'second.md', 'caller')

    const listed = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(
      listed.tabs.map((tab) => ['relativePath' in tab ? tab.relativePath : null, tab.isActive])
    ).toEqual([
      ['first.md', true],
      ['second.md', false]
    ])
    for (const [snapshot] of other.mock.calls) {
      expect(snapshot.tabs.find((tab: { isActive: boolean }) => tab.isActive)?.relativePath).toBe(
        'first.md'
      )
    }
  })

  it("moves only the host's focus for a phone's open, as the window route does", async () => {
    const { runtime, worktreeId, writeWorktreeFile } = await createHeadlessEditorHarness()
    await writeWorktreeFile('first.md', 'a')
    await writeWorktreeFile('second.md', 'b')
    await runtime.openMobileFile(`id:${worktreeId}`, 'first.md')
    const firstTabId = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs[0]!.id
    await runtime.activateMobileSessionTab(`id:${worktreeId}`, firstTabId, undefined, {
      notifyClients: false,
      clientNavigationId: 'phone',
      navigation: 'caller'
    })
    const phone = vi.fn()
    runtime.onMobileSessionTabsChanged(phone, 'phone')

    // Phones send no navigation on files.open / files.openDiff.
    await runtime.openMobileFile(`id:${worktreeId}`, 'second.md')
    await runtime.openMobileDiff(`id:${worktreeId}`, 'second.md', false)

    const activePath = (tabs: readonly { isActive: boolean; relativePath?: string }[]) =>
      tabs.find((tab) => tab.isActive)?.relativePath
    const host = await runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(host.tabs.find((tab) => tab.isActive)).toMatchObject({ mode: 'diff' })
    expect(
      activePath((await runtime.listMobileSessionTabs(`id:${worktreeId}`, 'phone')).tabs)
    ).toBe('first.md')
    expect(phone).toHaveBeenCalled()
    for (const [snapshot] of phone.mock.calls) {
      expect(snapshot.navigationIntent).toBeUndefined()
      expect(activePath(snapshot.tabs)).toBe('first.md')
    }

    const editor = attachEditorWindow(runtime)
    await runtime.openMobileFile(`id:${worktreeId}`, 'second.md')
    expect(editor.openFile).toHaveBeenCalledWith(
      worktreeId,
      expect.any(String),
      'second.md',
      undefined,
      undefined
    )
    detachEditorWindow(runtime)
  })

  it('keeps the window route unchanged while a desktop window owns editors', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    const editor = attachEditorWindow(runtime)

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')

    expect(editor.openFile).toHaveBeenCalledTimes(1)
    expect(getSession().openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    detachEditorWindow(runtime)
  })

  it('retires host diff tabs once a window takes editor authority', async () => {
    const { runtime, worktreeId } = await createHeadlessEditorHarness()
    await runtime.openMobileDiff(`id:${worktreeId}`, 'src/a.ts', false)

    attachEditorWindow(runtime)
    runtime.syncWindowGraph(TEST_WINDOW_ID, { tabs: [], leaves: [], rendererGeneration: 'g-1' })
    detachEditorWindow(runtime)
    runtime.markGraphUnavailable(TEST_WINDOW_ID)

    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toEqual([])
  })

  it('preserves host editor tabs against a renderer merge only while the host owns editors', async () => {
    const { runtime, worktreeId, writeWorktreeFile } = await createHeadlessEditorHarness()
    await writeWorktreeFile('notes.md', 'a')
    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preservation predicate and snapshot map are protected runtime members with these shapes.
    const preserve = runtime as never as {
      shouldPreserveHeadlessMobileSessionTab: (snapshot: unknown, tab: unknown) => boolean
      mobileSessionTabsByWorktree: Map<string, { tabs: unknown[] }>
    }
    const snapshot = preserve.mobileSessionTabsByWorktree.get(worktreeId)!
    const tab = snapshot.tabs[0]

    expect(preserve.shouldPreserveHeadlessMobileSessionTab.call(runtime, snapshot, tab)).toBe(true)
    attachEditorWindow(runtime)
    // Why: the window's publication is authoritative for editor closes it makes before flushing.
    expect(preserve.shouldPreserveHeadlessMobileSessionTab.call(runtime, snapshot, tab)).toBe(false)
    detachEditorWindow(runtime)
  })

  it('advertises the host editor tabs capability with and without a window', async () => {
    const { runtime } = await createHeadlessEditorHarness()
    expect(runtime.getStatus().capabilities).toContain(
      SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY
    )
    attachEditorWindow(runtime)
    expect(runtime.getStatus().capabilities).toContain(
      SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY
    )
    detachEditorWindow(runtime)
  })

  it('an explicit open keeps a preview tab so a window restore cannot replace it', async () => {
    const { runtime, worktreeId, writeWorktreeFile, getSession } =
      await createHeadlessEditorHarness((worktreeId, worktreePath) => ({
        ...getDefaultWorkspaceSession(),
        openFilesByWorktree: {
          [worktreeId]: [
            {
              filePath: `${worktreePath}/notes.md`,
              relativePath: 'notes.md',
              worktreeId,
              language: 'markdown',
              isPreview: true
            }
          ]
        }
      }))
    await writeWorktreeFile('notes.md', 'a')

    await runtime.openMobileFile(`id:${worktreeId}`, 'notes.md')

    expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([
      expect.not.objectContaining({ isPreview: true })
    ])
  })

  it('closes a read-only tab whose stale draft no surface shows', async () => {
    const { runtime, worktreeId, getSession } = await createHeadlessEditorHarness(
      (worktreeId, worktreePath) => ({
        ...getDefaultWorkspaceSession(),
        openFilesByWorktree: {
          [worktreeId]: [
            {
              filePath: `${worktreePath}/build.log`,
              relativePath: 'build.log',
              worktreeId,
              language: 'plaintext',
              readOnly: true,
              dirtyDraftContent: 'stale'
            }
          ]
        }
      })
    )
    const [tab] = (await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs
    expect(tab).toMatchObject({ isDirty: false })

    await runtime.closeMobileSessionTab(`id:${worktreeId}`, tab!.id)

    expect(getSession().openFilesByWorktree?.[worktreeId]).toEqual([])
  })
})
