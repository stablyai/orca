import { withoutGitGraph } from '../../../shared/workspace-layout/workspace-layout-client-visibility'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { applyWindowLayoutCommand } from '../../runtime/terminal/layout/runtime-layout-apply'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
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
    const held = store.getWorkspaceSession(routes[to]).tabGroups?.[to]?.[0]?.id
    await store.applyLayoutCommand(
      {
        type: 'openEditorTab',
        workspace: to,
        tabId: 'graph',
        fileId: 'graph',
        contentType: 'git-graph',
        view: {
          view: { mode: 'git-graph' },
          file: { filePath: 'graph', relativePath: 'graph', language: 'plaintext' }
        },
        groupId: 'hidden',
        ...(held ? { split: { besideGroupId: held, direction: 'right' as const } } : {})
      },
      [routes[to]!]
    )
    const destination = held ?? 'hidden'

    await expect(
      applyWindowLayoutCommand(
        store,
        hostIdsFor,
        {
          type: 'moveTabToWorkspace',
          workspace: from,
          toWorkspace: to,
          tabs: [{ tabId: 'e1', newTabId: 'e1', newEntityId: newId }],
          groupId: `group-${to}`,
          file: { filePath: path, relativePath: 'readme.md', language: 'markdown' }
        },
        undefined,
        { visibility: withoutGitGraph }
      )
    ).resolves.toEqual({ ok: true, result: { tabId: 'e1', groupId: destination } })

    // Inspect before reload: this fixture lacks the SSH repo needed to retain its workspace.
    const source = store.getWorkspaceSession(routes[from])
    const target = store.getWorkspaceSession(routes[to])
    expect(target.tabGroups?.[to]?.find((group) => group.id === destination)?.tabOrder).toEqual(
      held ? [TAB, 'e1'] : ['graph', 'e1']
    )
    expect(target.unifiedTabs?.[to]?.find((tab) => tab.id === 'graph')?.contentType).toBe(
      'git-graph'
    )
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
