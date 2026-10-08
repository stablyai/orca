/**
 * Folder workspaces need no Git for files, Markdown documents or notes on a host with no window;
 * diffs still need Git and refuse plainly instead of opening an empty tab.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import { projectMobileSessionFileTab } from '../../shared/mobile-session-editor-tab-projection'
import { getHostEditorTabState } from './host-editor-tab-state'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, getDefaultWorkspaceSession } =
  await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WINDOW_ID
} = await import('./orca-runtime-test-fixtures.spec')
const { attachEditorWindow, detachEditorWindow } =
  await import('./host-editor-tabs-test-harness.spec')

function sshFolderRuntime() {
  const folderStore = createFolderWorkspaceRuntimeStore(
    makeFolderWorkspace({ folderPath: '/srv/notes', executionHostId: 'ssh:target-1' }),
    makeFolderProjectGroup({ parentPath: '/srv' })
  )
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [TEST_FOLDER_WORKSPACE_KEY]: [
          {
            filePath: '/srv/notes/plan.md',
            relativePath: 'plan.md',
            worktreeId: TEST_FOLDER_WORKSPACE_KEY,
            language: 'markdown'
          }
        ]
      }
    },
    'ssh:target-1'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merged fixture implements every store method these folder paths call.
  return new OrcaRuntimeService({
    ...runtimeStore,
    ...folderStore,
    getWorkspaceSession: runtimeStore.getWorkspaceSession,
    setWorkspaceSession: runtimeStore.setWorkspaceSession,
    getWorkspaceSessionHostIds: () => ['local', 'ssh:target-1']
  } as never)
}

async function folderRuntime(
  initial: WorkspaceSessionState = getDefaultWorkspaceSession(),
  existingFolderPath?: string
) {
  const folderPath =
    existingFolderPath ?? (await mkdtemp(join(tmpdir(), 'orca-host-editor-folder-')))
  const folderStore = createFolderWorkspaceRuntimeStore(
    makeFolderWorkspace({ folderPath }),
    makeFolderProjectGroup({ parentPath: folderPath })
  )
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(initial)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merged fixture implements every store method these folder paths call.
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    ...folderStore,
    getWorkspaceSession: runtimeStore.getWorkspaceSession,
    setWorkspaceSession: runtimeStore.setWorkspaceSession
  } as never)
  return { runtime, folderPath, getSession, selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
}

describe('host-owned editor tabs in a folder workspace', () => {
  it('opens, reads and saves a Markdown file with no Git', async () => {
    const { runtime, folderPath, selector, getSession } = await folderRuntime()
    await writeFile(join(folderPath, 'plan.md'), 'draft one')

    await runtime.openMobileFile(selector, 'plan.md')
    const [tab] = (await runtime.listMobileSessionTabs(selector)).tabs
    const read = await runtime.readMobileMarkdownTab(selector, tab!.id)
    await runtime.saveMobileMarkdownTab(selector, tab!.id, read.version, 'draft two')

    expect(tab).toMatchObject({ type: 'markdown', relativePath: 'plan.md' })
    expect(read).toMatchObject({ content: 'draft one', editable: true })
    expect(await readFile(join(folderPath, 'plan.md'), 'utf8')).toBe('draft two')
    expect(getSession().openFilesByWorktree?.[TEST_FOLDER_WORKSPACE_KEY]).toHaveLength(1)
    expect(hashMarkdownContent('draft two')).toBe(
      (await runtime.readMobileMarkdownTab(selector, tab!.id)).version
    )
  })

  it("refuses a diff in a folder that isn't a Git repository, opening no tab", async () => {
    const { runtime, selector } = await folderRuntime()

    await expect(runtime.openMobileDiff(selector, 'plan.md', false)).rejects.toThrow(
      "This folder isn't a Git repository."
    )
    expect((await runtime.listMobileSessionTabs(selector)).tabs).toEqual([])
  })

  it('finds an editor-only folder workspace in the unscoped inventory', async () => {
    const { runtime, folderPath, selector, getSession } = await folderRuntime()
    await writeFile(join(folderPath, 'plan.md'), 'x')
    await runtime.openMobileFile(selector, 'plan.md')

    const restarted = await folderRuntime(getSession(), folderPath)
    const all = await restarted.runtime.listAllMobileSessionTabs()

    expect(all.find((snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY)?.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'plan.md' })
    ])
  })

  it.each([false, true])(
    'keeps an SSH folder workspace edit tab beside a live diff in the full list (scoped first: %s)',
    async (scopedFirst) => {
      const runtime = sshFolderRuntime()
      // A live diff stands in for one the phone opened; folder workspaces only get diffs via Git.
      getHostEditorTabState(runtime).addDiff({
        tabId: 'diff-1',
        fileId: `${TEST_FOLDER_WORKSPACE_KEY}::diff::unstaged::plan.md`,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        filePath: '/srv/notes/plan.md',
        relativePath: 'plan.md',
        diffSource: 'unstaged',
        language: 'markdown',
        executionHostId: 'ssh:target-1',
        groupId: null,
        returnFocusTabId: null
      })
      const scopedTypes = async () =>
        (await runtime.listMobileSessionTabs(`id:${TEST_FOLDER_WORKSPACE_KEY}`)).tabs.map(
          (tab) => tab.type
        )
      const allTypes = async () =>
        (await runtime.listAllMobileSessionTabs())
          .find((snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY)
          ?.tabs.map((tab) => tab.type)

      if (scopedFirst) {
        expect(await scopedTypes()).toEqual(['markdown', 'file'])
      }
      expect(await allTypes()).toEqual(['markdown', 'file'])
      expect(await scopedTypes()).toEqual(['markdown', 'file'])
      expect(await allTypes()).toEqual(['markdown', 'file'])
    }
  )

  it("drops the closed window's last tabs for an SSH folder workspace from the full list too", async () => {
    const runtime = sshFolderRuntime()
    attachEditorWindow(runtime)
    const windowDiff = projectMobileSessionFileTab(
      { tabId: 'win-diff-1', isActive: true },
      {
        id: 'win-diff-file',
        filePath: '/srv/notes/plan.md',
        relativePath: 'plan.md',
        language: 'markdown',
        mode: 'diff',
        isDirty: false,
        diffSource: 'unstaged'
      }
    )
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'g-1',
      mobileSessionTabs: [
        {
          worktree: TEST_FOLDER_WORKSPACE_KEY,
          publicationEpoch: 'window-1',
          snapshotVersion: 1,
          activeGroupId: 'g-1',
          activeTabId: 'win-diff-1',
          activeTabType: 'file',
          tabGroups: [{ id: 'g-1', activeTabId: 'win-diff-1', tabOrder: ['win-diff-1'] }],
          tabs: [windowDiff]
        }
      ]
    })
    runtime.markGraphUnavailable(TEST_WINDOW_ID)
    detachEditorWindow(runtime)

    const all = (await runtime.listAllMobileSessionTabs()).find(
      (snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY
    )
    const scoped = await runtime.listMobileSessionTabs(`id:${TEST_FOLDER_WORKSPACE_KEY}`)

    expect(all?.tabs.map((tab) => [tab.type, tab.id])).toEqual(
      scoped.tabs.map((tab) => [tab.type, tab.id])
    )
    expect(scoped.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'plan.md' })
    ])
  })

  it('finds an editor-only workspace stored in an SSH folder partition', async () => {
    const runtime = sshFolderRuntime()

    const all = await runtime.listAllMobileSessionTabs()

    expect(all.find((snapshot) => snapshot.worktree === TEST_FOLDER_WORKSPACE_KEY)?.tabs).toEqual([
      expect.objectContaining({ type: 'markdown', relativePath: 'plan.md' })
    ])
  })
})
