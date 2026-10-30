import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { applyWindowLayoutCommand } from '../../runtime/runtime-layout-apply'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function storeWithTerminal(worktreeId: string): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-editor-apply-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(worktreeId, TAB, LEAF)
  store.setWorkspaceSession(window.snapshot())
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

function editorOpen(worktreeId: string, tabId: string, path: string) {
  return {
    type: 'openEditorTab',
    workspace: worktreeId,
    tabId,
    fileId: path,
    contentType: 'editor',
    groupId: `group-${worktreeId}`,
    preview: true,
    file: { filePath: path, relativePath: path.slice(1), language: 'typescript' }
  } as const
}

describe.each([
  ['a git worktree', FIXTURE_GIT_WORKTREE_ID],
  ['a folder workspace', FIXTURE_FOLDER_WORKTREE_ID]
])('Store.applyLayoutCommand editor tabs in %s', (_name, worktreeId) => {
  it('saves a preview open, its replacement and a close durably, leaving the terminal', async () => {
    const { store, directory } = await storeWithTerminal(worktreeId)

    await expect(store.applyLayoutCommand(editorOpen(worktreeId, 'e1', '/a.ts'))).resolves.toEqual({
      ok: true,
      result: { tabId: 'e1', refused: [] }
    })
    const reopened = await reopenTopologyStore(store, directory)
    let session = reopened.getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([TAB, 'e1'])
    expect(session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === 'e1')).toMatchObject({
      entityId: '/a.ts',
      contentType: 'editor',
      isPreview: true
    })
    expect(session.openFilesByWorktree?.[worktreeId]).toEqual([
      expect.objectContaining({ filePath: '/a.ts', isPreview: true })
    ])

    await reopened.applyLayoutCommand(editorOpen(worktreeId, 'e2', '/b.ts'))
    await reopened.applyLayoutCommand({ type: 'closeTabs', workspace: worktreeId, tabIds: ['e2'] })
    session = (await reopenTopologyStore(reopened, directory)).getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([TAB])
    expect(session.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual([TAB])
    expect(session.openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([TAB])
  })

  it('saves an open file renamed on disk under its new id and path durably', async () => {
    const { store, directory } = await storeWithTerminal(worktreeId)
    await store.applyLayoutCommand({ ...editorOpen(worktreeId, 'e1', '/a.ts'), preview: undefined })

    await expect(
      store.applyLayoutCommand({
        type: 'renameEditorFiles',
        workspace: worktreeId,
        renames: [
          {
            fileId: '/a.ts',
            newFileId: '/src/b.ts',
            record: {
              fromFilePath: '/a.ts',
              file: { filePath: '/src/b.ts', relativePath: 'src/b.ts', language: 'typescript' }
            }
          }
        ]
      })
    ).resolves.toEqual({ ok: true, result: { renamedTabIds: {} } })

    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.tabGroups?.[worktreeId]?.[0]?.tabOrder).toEqual([TAB, 'e1'])
    expect(session.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === 'e1')).toMatchObject({
      entityId: '/src/b.ts'
    })
    expect(session.openFilesByWorktree?.[worktreeId]).toEqual([
      expect.objectContaining({ filePath: '/src/b.ts', relativePath: 'src/b.ts' })
    ])
  })
})

describe('Store.applyLayoutCommand moveTabToWorkspace', () => {
  it.each([
    ['a git worktree to a folder workspace', FIXTURE_GIT_WORKTREE_ID, FIXTURE_FOLDER_WORKTREE_ID],
    ['a folder workspace to a git worktree', FIXTURE_FOLDER_WORKTREE_ID, FIXTURE_GIT_WORKTREE_ID]
  ])('moves a restored editor tab from %s durably', async (_name, from, to) => {
    const { store, directory } = await storeWithTerminal(from)
    const path = '/fixture/other/readme.md'
    const open = { ...editorOpen(from, 'e1', path), preview: undefined }
    await store.applyLayoutCommand({ ...open, file: { ...open.file, relativePath: path } })
    const newId = `editor:${to}:${path}`

    await expect(
      store.applyLayoutCommand({
        type: 'moveTabToWorkspace',
        workspace: from,
        toWorkspace: to,
        tabs: [{ tabId: 'e1', newTabId: 'e1', newEntityId: newId }],
        groupId: `group-${to}`,
        file: { filePath: path, relativePath: 'readme.md', language: 'markdown' }
      })
    ).resolves.toEqual({ ok: true, result: { tabId: 'e1', groupId: `group-${to}` } })

    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.tabGroups?.[from]?.[0]?.tabOrder).toEqual([TAB])
    expect(session.tabGroups?.[to]?.[0]).toMatchObject({ id: `group-${to}`, tabOrder: ['e1'] })
    expect(session.unifiedTabs?.[to]?.[0]).toMatchObject({ id: 'e1', entityId: newId })
    expect(session.openFilesByWorktree?.[from] ?? []).toEqual([])
    expect(session.openFilesByWorktree?.[to]).toEqual([
      expect.objectContaining({ filePath: path, relativePath: 'readme.md', worktreeId: to })
    ])
  })
})

describe('a window moveTabToWorkspace between a local and an SSH workspace', () => {
  const SSH_HOST = 'ssh:target-1'
  const SSH_WORKTREE = 'repo-ssh::/home/dev/api'
  const routes: Record<string, ExecutionHostId> = {
    [FIXTURE_GIT_WORKTREE_ID]: 'local',
    [SSH_WORKTREE]: SSH_HOST
  }
  const hostIdsFor = (worktreeId: string) => (routes[worktreeId] ? [routes[worktreeId]] : [])

  it.each([
    ['local to SSH', FIXTURE_GIT_WORKTREE_ID, SSH_WORKTREE],
    ['SSH to local', SSH_WORKTREE, FIXTURE_GIT_WORKTREE_ID]
  ])('moves a restored editor tab %s in one durable write', async (_name, from, to) => {
    const { store, directory } = await storeWithTerminal(FIXTURE_GIT_WORKTREE_ID)
    const path = '/fixture/other/readme.md'
    const open = { ...editorOpen(from, 'e1', path), preview: undefined }
    await store.applyLayoutCommand({ ...open, file: { ...open.file, relativePath: path } }, [
      routes[from]!
    ])
    const newId = `editor:${to}:${path}`

    await expect(
      applyWindowLayoutCommand(store, hostIdsFor, {
        type: 'moveTabToWorkspace',
        workspace: from,
        toWorkspace: to,
        tabs: [{ tabId: 'e1', newTabId: 'e1', newEntityId: newId }],
        groupId: `group-${to}`,
        file: { filePath: path, relativePath: 'readme.md', language: 'markdown' }
      })
    ).resolves.toEqual({ ok: true, result: { tabId: 'e1', groupId: `group-${to}` } })

    // Inspect before reload: this fixture lacks the SSH repo needed to retain its workspace.
    const source = store.getWorkspaceSession(routes[from])
    const target = store.getWorkspaceSession(routes[to])
    expect(source.unifiedTabs?.[from]?.some((tab) => tab.id === 'e1') ?? false).toBe(false)
    expect(source.openFilesByWorktree?.[from] ?? []).toEqual([])
    expect(target.unifiedTabs?.[to]?.find((tab) => tab.id === 'e1')).toMatchObject({
      entityId: newId
    })
    expect(target.openFilesByWorktree?.[to]).toEqual([
      expect.objectContaining({ filePath: path, relativePath: 'readme.md', worktreeId: to })
    ])
    const reopened = await reopenTopologyStore(store, directory)
    expect(reopened.getWorkspaceSession('local').tabsByWorktree[FIXTURE_GIT_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: TAB })
    ])
    expect(
      reopened
        .getWorkspaceSession('local')
        .unifiedTabs?.[FIXTURE_GIT_WORKTREE_ID]?.some((tab) => tab.id === 'e1')
    ).toBe(to === FIXTURE_GIT_WORKTREE_ID)
  })
})
