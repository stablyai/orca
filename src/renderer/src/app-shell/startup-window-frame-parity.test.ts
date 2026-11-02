// Compare frame-applied slices with disk-session startup restore. Views may differ only by Loader parity entries; slice differences are enumerated below.

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  localDesktopSession,
  WORKSPACE_LAYOUT_PROFILES,
  type WorkspaceLayoutProfile
} from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { AppState } from '../store/types'
import {
  buildLayoutFrameSlices,
  type LayoutFrameSliceInput,
  type LayoutFrameSlices
} from '../store/workspace-layout-frame-slices'
import {
  ACCEPTED_DIFFERENCES,
  GIT,
  KNOWN_DIFFERENCES,
  sweptAtStartup
} from './startup-window-parity-differences.test-fixture'
import {
  bootWindowFromPartitions,
  diffStartupWindowViews,
  projectStartupWindowView
} from './startup-window-view.test-fixture'

// Compare layout-owner main/frame application against legacy window restore.
const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

/** Editor tabs whose files another host owns: an SSH file outside the worktree, a server's file. */
function filesOfOtherHosts(): WorkspaceSessionState {
  const session = localDesktopSession()
  const group = session.tabGroups![GIT_KEY]![0]!
  const owners = [
    { path: '/home/dev/notes.md', host: toSshExecutionHostId('box'), externalSshTargetId: 'box' },
    {
      path: '/srv/app/main.go',
      host: toRuntimeExecutionHostId('env-1'),
      runtimeEnvironmentId: 'env-1'
    }
  ]
  for (const [index, { path, host, ...owner }] of owners.entries()) {
    const id = `editor:${path}`
    group.tabOrder.push(id)
    session.unifiedTabs![GIT_KEY]!.push({
      id,
      entityId: path,
      groupId: group.id,
      worktreeId: GIT_KEY,
      executionHostId: host,
      contentType: 'editor',
      label: path.split('/').at(-1)!,
      customLabel: null,
      color: null,
      sortOrder: group.tabOrder.length - 1,
      createdAt: 1_700_000_100_000 + index
    })
    session.openFilesByWorktree![GIT_KEY]!.push({
      filePath: path,
      relativePath: path,
      worktreeId: GIT_KEY,
      language: 'plaintext',
      ...owner
    })
  }
  // Keyed by file id, which restore rekeys for the server's file.
  session.markdownFrontmatterVisible = { '/srv/app/main.go': false }
  return session
}

/** Groups with no selected tab: one beside a terminal, one in a workspace without terminals. */
function groupsWithoutSelection(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-t', activeTabId: null, tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] }
  ])
  addWorkspace(session, FOLDER_KEY, [
    {
      id: 'group-e',
      activeTabId: null,
      tabs: [{ id: 'editor-1', entityId: '/notes/todo.md', kind: 'editor' }]
    }
  ])
  session.openFilesByWorktree = {
    [FOLDER_KEY]: [
      {
        filePath: '/notes/todo.md',
        relativePath: 'todo.md',
        worktreeId: FOLDER_KEY,
        language: 'markdown'
      }
    ]
  }
  return session
}

/** An editor tab Orca moved to the workspace owning its file: saved under the file's owned id. */
function movedEditorTab(): WorkspaceSessionState {
  const filePath = '/Users/dev/orca/docs/readme.md'
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-m',
      activeTabId: 'editor-moved',
      tabs: [
        {
          id: 'editor-moved',
          entityId: buildOwnedEditorFileId(filePath, GIT_KEY, null),
          kind: 'editor'
        }
      ]
    }
  ])
  session.openFilesByWorktree = {
    [GIT_KEY]: [
      { filePath, relativePath: 'docs/readme.md', worktreeId: GIT_KEY, language: 'markdown' }
    ]
  }
  return session
}

const PROFILES: readonly WorkspaceLayoutProfile[] = [
  ...WORKSPACE_LAYOUT_PROFILES,
  ...LEGACY_WORKSPACE_LAYOUT_PROFILES,
  { name: 'an editor tab moved to its file’s workspace', hostId: 'local', build: movedEditorTab },
  { name: 'editor files other hosts own', hostId: 'local', build: filesOfOtherHosts },
  { name: 'groups with no selected tab', hostId: 'local', build: groupsWithoutSelection }
]

/** What main publishes for a stored partition after its startup sweep, and what the Loader keeps beside the layout. */
function frameInput(hostId: ExecutionHostId, stored: WorkspaceSessionState): LayoutFrameSliceInput {
  const { layout, facts, desktopView } = loadWorkspaceLayoutWithoutReport(
    hostId,
    sweptAtStartup(hostId, stored),
    nameBasedLoadContext()
  )
  return {
    layouts: Object.fromEntries(
      Object.entries(layout.workspaces).map(([key, workspace]) => [
        key,
        publishWorkspaceLayout(workspace, hostId)
      ])
    ),
    facts,
    view: desktopView
  }
}

function diffSlices(restored: unknown, applied: unknown, path: string, into: string[]): string[] {
  if (JSON.stringify(restored) === JSON.stringify(applied)) {
    return into
  }
  if (
    typeof restored === 'object' &&
    restored !== null &&
    typeof applied === 'object' &&
    applied !== null
  ) {
    const restoredFields: Record<string, unknown> = { ...restored }
    const appliedFields: Record<string, unknown> = { ...applied }
    for (const key of new Set([...Object.keys(restoredFields), ...Object.keys(appliedFields)])) {
      diffSlices(restoredFields[key], appliedFields[key], `${path} ${key}`, into)
    }
    return into
  }
  into.push(path)
  return into
}

const PARITY_REATTACH_ONLY = (paths: string[]): boolean =>
  paths.every((path) => path.endsWith(' reattaches'))

/** Loader parity paths excluding reconnect-only state the frame applier never writes. */
function loaderParityPaths(fixture: string): string[] {
  return [
    ...KNOWN_DIFFERENCES.filter((entry) => entry.fixture === fixture).flatMap(
      (entry) => entry.paths
    ),
    ...ACCEPTED_DIFFERENCES.filter((entry) => entry.fixture === fixture)
      .map((entry) => Object.keys(entry.values))
      // What a tab reattaches is the startup reconnect plan's, not the frames'.
      .filter((paths) => !PARITY_REATTACH_ONLY(paths))
      .flat()
  ]
}

type SliceDifference = {
  fixture: string
  /** A Loader parity entry's rule, or why frames differ from the restore. */
  cause: string
  paths: string[]
}

/** Slice paths that differ. Entries may only be removed. */
const SLICE_DIFFERENCES: readonly SliceDifference[] = [
  {
    fixture: 'legacy surface tombstone on a pane still showing its terminal',
    cause: 'tombstones (Loader parity)',
    paths: [
      `tabsByWorktree ${GIT} 1`,
      'terminalLayoutsByTabId tab-b',
      `unifiedTabsByWorktree ${GIT} 1`,
      `groupsByWorktree ${GIT} 0 tabOrder 1`
    ]
  },
  {
    fixture: 'tab-bar label differing from the row title',
    cause: 'label over title (Loader parity)',
    paths: [`tabsByWorktree ${GIT} 0 title`]
  },
  {
    fixture: 'row without a tab-bar entry, still bound to a terminal',
    cause:
      'host stamp: a frame names every tab’s host; an adopted tab-bar entry leaves it absent, which readers take as the workspace’s',
    paths: [`unifiedTabsByWorktree ${GIT} 1 executionHostId`]
  },
  {
    fixture: 'row without a tab-bar entry, its terminal only on a relay',
    cause: 'host stamp (above)',
    paths: [`unifiedTabsByWorktree ${GIT} 1 executionHostId`]
  },
  {
    fixture: 'legacy split row sharing one pane’s terminal with a tab-bar tab',
    cause: 'host stamp (above)',
    paths: [`unifiedTabsByWorktree ${GIT} 2 executionHostId`]
  },
  {
    fixture: 'session from before the tab bar, with an open file',
    cause:
      'root group: the Loader names it from the workspace key, the window mints a random id; ids are never shown. Host stamp (above). An empty recent list where the adopted group has none',
    paths: [
      `unifiedTabsByWorktree ${GIT} 0 groupId`,
      `unifiedTabsByWorktree ${GIT} 0 executionHostId`,
      `unifiedTabsByWorktree ${GIT} 1 groupId`,
      `unifiedTabsByWorktree ${GIT} 1 executionHostId`,
      `groupsByWorktree ${GIT} 0 id`,
      `groupsByWorktree ${GIT} 0 recentTabIds`,
      `activeGroupIdByWorktree ${GIT}`,
      `layoutByWorktree ${GIT} groupId`
    ]
  },
  {
    fixture: 'session from before the tab bar, a row with no terminal',
    cause: 'root group and host stamp (above), for the one kept tab',
    paths: [
      `unifiedTabsByWorktree ${GIT} 0 groupId`,
      `unifiedTabsByWorktree ${GIT} 0 executionHostId`,
      `groupsByWorktree ${GIT} 0 id`,
      `groupsByWorktree ${GIT} 0 recentTabIds`,
      `activeGroupIdByWorktree ${GIT}`,
      `layoutByWorktree ${GIT} groupId`
    ]
  }
]

async function restoreAndApply(profile: WorkspaceLayoutProfile): Promise<{
  restored: AppState
  applied: LayoutFrameSlices
}> {
  const stored = profile.build()
  layoutOwner.isMain = false
  const restored = await bootWindowFromPartitions(createTestStore(), [
    { hostId: profile.hostId, session: stored }
  ]).finally(() => {
    layoutOwner.isMain = true
  })
  return { restored, applied: buildLayoutFrameSlices(frameInput(profile.hostId, stored)) }
}

describe('the slices built from layout frames match the window restored from disk', () => {
  it.each(PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s',
    async (name, profile) => {
      const { restored, applied } = await restoreAndApply(profile)
      const restoredSlices: Record<string, unknown> = { ...restored }
      const sliceDifferences = Object.entries(applied).flatMap(([slice, value]) =>
        diffSlices(restoredSlices[slice], value, slice, [])
      )
      expect(sliceDifferences.sort(), JSON.stringify(sliceDifferences, null, 2)).toEqual(
        SLICE_DIFFERENCES.filter((entry) => entry.fixture === name)
          .flatMap((entry) => entry.paths)
          .sort()
      )
      // Global selection stays the view's, so the window keeps the restored one.
      const viewDifferences = diffStartupWindowViews(
        projectStartupWindowView(restored),
        projectStartupWindowView({ ...restored, ...applied })
      )
      expect(viewDifferences.map((difference) => difference.path).sort()).toEqual(
        loaderParityPaths(name).sort()
      )
    }
  )

  it('covers every partition kind, a remount generation, and every tab kind', async () => {
    const local = await restoreAndApply(PROFILES[0]!)
    const tabs = Object.values(local.applied.unifiedTabsByWorktree).flat()
    expect(new Set(tabs.map((tab) => tab.contentType))).toEqual(
      new Set(['terminal', 'editor', 'browser', 'agent-session'])
    )
    expect(local.applied.tabsByWorktree[GIT]!.find((row) => row.id === 'term-agent')).toMatchObject(
      { generation: 2, viewMode: 'chat', launchAgent: 'claude' }
    )
    expect(local.applied.browserTabsByWorktree[GIT]![0]).toMatchObject({ label: 'Browser 1' })
    const hosts = new Set<string>()
    for (const profile of PROFILES) {
      const { applied } = await restoreAndApply(profile)
      for (const tab of Object.values(applied.unifiedTabsByWorktree).flat()) {
        hosts.add(tab.executionHostId!.split(':')[0]!)
      }
    }
    expect(hosts).toEqual(new Set(['local', 'ssh', 'runtime']))
    const otherHosts = await restoreAndApply(PROFILES.at(-2)!)
    expect(otherHosts.applied.markdownFrontmatterVisible).toEqual({
      [`editor:${encodeURIComponent(GIT)}:env-1:${encodeURIComponent('/srv/app/main.go')}`]: false
    })
    expect(Object.keys(local.applied.groupsByWorktree)).toContain('folder:notes-1')
  })

  it('selects a group’s first tab when the view selects none, with or without terminals', async () => {
    const { applied } = await restoreAndApply(PROFILES.at(-1)!)
    expect(applied.groupsByWorktree[GIT_KEY]![0]!.activeTabId).toBe('tab-a')
    expect(applied.groupsByWorktree[FOLDER_KEY]![0]!.activeTabId).toBe('editor-1')
  })

  it('titles a terminal tab from the live title of the pane this view focuses', () => {
    const input = frameInput('local', localDesktopSession())
    const shell = input.layouts[GIT]!.tabs.find((tab) => tab.id === 'tab-shell')!
    shell.terminal!.panes = shell.terminal!.panes.map((pane, index) => ({
      ...pane,
      liveTitle: `pane ${index + 1}`
    }))
    const titleOf = (slices: LayoutFrameSlices) => ({
      row: slices.tabsByWorktree[GIT]!.find((row) => row.id === 'tab-shell')!.title,
      label: slices.unifiedTabsByWorktree[GIT]!.find((tab) => tab.id === 'tab-shell')!.label
    })
    expect(titleOf(buildLayoutFrameSlices(input))).toEqual({ row: 'pane 1', label: 'pane 1' })
    input.view.panes['tab-shell'] = { activeLeafId: leaf(2), expandedLeafId: null }
    expect(titleOf(buildLayoutFrameSlices(input))).toEqual({ row: 'pane 2', label: 'pane 2' })
  })

  it('keeps a live agent title a frame reports instead of resetting it as restore does', () => {
    const input = frameInput('local', localDesktopSession())
    const shell = input.layouts[GIT]!.tabs.find((tab) => tab.id === 'tab-shell')!
    shell.terminal!.panes = shell.terminal!.panes.map((pane) => ({
      ...pane,
      liveTitle: '\u280b use Claude Sonnet'
    }))
    const row = buildLayoutFrameSlices(input).tabsByWorktree[GIT]!.find(
      (tab) => tab.id === 'tab-shell'
    )!
    expect(row.title).toBe('\u280b use Claude Sonnet')
  })

  it('restores a browser tab from a frame without its creation time, as the tab-bar tab’s', () => {
    const input = frameInput('local', localDesktopSession())
    const browser = input.layouts[GIT]!.browserTabs[0]!
    delete browser.createdAt
    const entry = input.layouts[GIT]!.tabs.find((tab) => tab.entityId === browser.id)!
    expect(buildLayoutFrameSlices(input).browserTabsByWorktree[GIT]![0]!.createdAt).toBe(
      entry.createdAt
    )
  })

  it('lists differences only for fixtures that exist', () => {
    const names = new Set(PROFILES.map((profile) => profile.name))
    expect(SLICE_DIFFERENCES.filter((entry) => !names.has(entry.fixture))).toEqual([])
  })
})
