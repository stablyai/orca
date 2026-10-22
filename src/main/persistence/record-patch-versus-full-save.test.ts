// Ledger L104: each writer of the touched-records patch against a full save of main's model. They
// differ on 50 of the 51 legacy fixture x writer pairs, only on records the Loader rewrites; every
// pair is pinned exactly, so the patch goes only once no partition holds such rows.

import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import {
  diffStoredSession,
  stableJson,
  type LayoutLoadChange
} from '../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  relaySshSession,
  WORKSPACE_LAYOUT_PROFILES,
  type WorkspaceLayoutProfile
} from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import type * as RecordPatch from '../../shared/workspace-layout/workspace-layout-record-patch'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import { SSH_KEY } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { moveTabAcrossPartitions } from './terminal-topology/cross-partition-tab-move'
import {
  admitPaneToSession,
  applyCommandToSession,
  applyRenamesToSession
} from './terminal-topology/terminal-pane-admission'
import { windowViewPatchForMain, windowViewSaveForMain } from './window-save-view'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

/** Each patch a writer made: the stored partition, the full saves before and after, the patch. */
type PatchCall = {
  hostId: ExecutionHostId
  stored: WorkspaceSessionState
  before: WorkspaceSessionState
  full: WorkspaceSessionState
  patched: WorkspaceSessionState
}
const patches = vi.hoisted(() => {
  const calls: PatchCall[] = []
  const hostIds: ExecutionHostId[] = []
  return { calls, hostIds }
})
vi.mock('../../shared/workspace-layout/workspace-layout-record-patch', async (importOriginal) => {
  const actual = await importOriginal<typeof RecordPatch>()
  return {
    patchStoredSession: (
      stored: WorkspaceSessionState,
      before: WorkspaceSessionState,
      full: WorkspaceSessionState
    ) => {
      const patched = actual.patchStoredSession(stored, before, full)
      patches.calls.push({
        hostId: patches.hostIds.shift() ?? LOCAL_EXECUTION_HOST_ID,
        stored,
        before,
        full,
        patched
      })
      return patched
    }
  }
})

const SSH_HOST = toSshExecutionHostId('target-1')
const MOVED_FILE = {
  filePath: '/Users/dev/api/readme.md',
  relativePath: 'readme.md',
  language: 'markdown'
}

/** Records (or session fields) two partitions hold differently. */
const recordsDiffering = (left: WorkspaceSessionState, right: WorkspaceSessionState) =>
  [
    ...new Set(
      diffStoredSession(left, right).map(({ table, record, field }) =>
        table === 'session' ? `session/${field}` : `${table}/${record}`
      )
    )
  ].sort()

/** What the partition loads to; the revision is exempt, as every load's tombstone pass bumps it. */
const reloaded = (hostId: ExecutionHostId, session: WorkspaceSessionState) =>
  stableJson({
    ...saveWorkspaceLayout(loadWorkspaceLayout(hostId, session, nameBasedLoadContext())),
    terminalTopologyRevisionByRepoId: undefined
  })

/** The patches one write made, each with the partition it wrote (in the order it patches them). */
function captured(hostIds: readonly ExecutionHostId[], run: () => void): PatchCall[] {
  patches.calls = []
  patches.hostIds = [...hostIds]
  run()
  return patches.calls
}

type Writer = (profile: WorkspaceLayoutProfile) => PatchCall[][]

function firstTerminal(profile: WorkspaceLayoutProfile) {
  const stored = profile.build()
  const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
  for (const [workspace, layout] of Object.entries(loaded.layout.workspaces)) {
    const tab = layout.tabs.find((candidate) => candidate.kind === 'terminal')
    if (tab?.kind === 'terminal') {
      const leafId = collectLayoutLeafIdsInOrder(tab.panes.root)[0]
      return { stored, workspace, tabId: tab.id, leafId, groupId: layout.groups[0]!.id }
    }
  }
  return null
}

const NEW_LEAF = '99999999-9999-4999-8999-999999999999'

function layoutApplyCommands(
  target: NonNullable<ReturnType<typeof firstTerminal>>
): LayoutCommand[] {
  const { workspace, tabId, leafId, groupId } = target
  return [
    { type: 'renameTab', workspace, tabId, kind: 'custom', title: 'Renamed' },
    {
      type: 'splitPane',
      workspace,
      tabId,
      leafId: leafId!,
      direction: 'vertical',
      newLeafId: NEW_LEAF
    },
    { type: 'closeTabs', workspace, tabIds: [tabId], force: true },
    {
      type: 'createTerminalTab',
      workspace,
      tabId: 'tab-new',
      leafId: NEW_LEAF,
      groupId,
      createdAt: 1
    }
  ]
}

const APPLY = 'layout.apply (terminal-pane-admission)'
const MOVE = 'cross-partition editor move'
const SAVE = 'window save (window-save-view)'
type WriterName = typeof APPLY | typeof MOVE | typeof SAVE

const WRITERS: Record<WriterName, Writer> = {
  [APPLY]: (profile) => {
    const target = firstTerminal(profile)
    if (!target) {
      return []
    }
    return [
      ...layoutApplyCommands(target).map((command) =>
        captured([profile.hostId], () =>
          applyCommandToSession(profile.hostId, target.stored, command)
        )
      ),
      captured([profile.hostId], () =>
        applyRenamesToSession(profile.hostId, target.stored, [
          {
            type: 'renameTab',
            workspace: target.workspace,
            tabId: target.tabId,
            kind: 'generated',
            title: 'vim'
          }
        ])
      ),
      captured([profile.hostId], () =>
        admitPaneToSession(profile.hostId, target.stored, {
          type: 'splitPane',
          workspace: target.workspace,
          tabId: target.tabId,
          leafId: target.leafId!,
          direction: 'horizontal',
          newLeafId: NEW_LEAF
        })
      )
    ]
  },
  [MOVE]: (profile) => {
    const target = firstTerminal(profile)
    if (!target || profile.hostId !== LOCAL_EXECUTION_HOST_ID) {
      return []
    }
    const opened = applyCommandToSession(profile.hostId, target.stored, {
      type: 'openEditorTab',
      workspace: target.workspace,
      tabId: 'e-move',
      fileId: MOVED_FILE.filePath,
      contentType: 'editor',
      groupId: target.groupId,
      createdAt: 1,
      file: MOVED_FILE
    }).session!
    return [
      captured([profile.hostId, SSH_HOST], () =>
        moveTabAcrossPartitions(
          { hostId: profile.hostId, session: opened },
          { hostId: SSH_HOST, session: relaySshSession('target-1') },
          {
            type: 'moveTabToWorkspace',
            workspace: target.workspace,
            toWorkspace: SSH_KEY,
            tabs: [
              {
                tabId: 'e-move',
                newTabId: 'e-move',
                newEntityId: `editor:${SSH_KEY}:${MOVED_FILE.filePath}`
              }
            ],
            groupId: 'group-ssh',
            file: MOVED_FILE
          }
        )
      )
    ]
  },
  [SAVE]: (profile) => {
    const stored = profile.build()
    const firstTab = Object.values(stored.tabsByWorktree).flat()[0]
    // The window echoes the stored partition with a new selection and a title its view reported.
    const save: WorkspaceSessionState = {
      ...stored,
      activeTabId: firstTab?.id ?? null,
      tabsByWorktree: Object.fromEntries(
        Object.entries(stored.tabsByWorktree).map(([key, rows]) => [
          key,
          rows.map((row, index) => (index === 0 ? { ...row, title: 'reported' } : row))
        ])
      )
    }
    return [
      captured([profile.hostId], () => windowViewSaveForMain(stored, save, profile.hostId)),
      captured([profile.hostId], () =>
        windowViewPatchForMain(stored, { tabsByWorktree: save.tabsByWorktree }, profile.hostId)
      )
    ]
  }
}

/** The session list each record table is stored in: a record the load rewrites can change it. */
const LIST_FIELD_OF_TABLE: Readonly<Record<string, string>> = {
  row: 'tabsByWorktree',
  terminalEntry: 'unifiedTabs',
  entry: 'unifiedTabs',
  group: 'tabGroups',
  layout: 'terminalLayoutsByTabId',
  file: 'openFilesByWorktree',
  browser: 'browserTabsByWorktree'
}

/**
 * Whether a session list field's workspace keys differ only where the load rewrote a record of
 * that list: a full save drops a workspace's emptied list that the patch keeps with its stored row.
 */
function listKeysFollowLoad(change: LayoutLoadChange, normalized: readonly string[]): boolean {
  const tables = Object.keys(LIST_FIELD_OF_TABLE).filter(
    (table) => LIST_FIELD_OF_TABLE[table] === change.field
  )
  const keys = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])
  const before = keys(change.before)
  const after = keys(change.after)
  const moved = [
    ...before.filter((key) => !after.includes(key)),
    ...after.filter((key) => !before.includes(key))
  ]
  return (
    tables.length > 0 &&
    moved.length > 0 &&
    moved.every((key) =>
      normalized.some((record) => tables.some((table) => record.startsWith(`${table}/${key}|`)))
    )
  )
}

/** The records a writer's patches differ from its full saves in. */
function differingRecords(calls: readonly PatchCall[]): string[] {
  const differing = new Set<string>()
  for (const call of calls) {
    const normalized = recordsDiffering(call.stored, call.before)
    const differs = recordsDiffering(call.full, call.patched)
    const listKeyChanges = diffStoredSession(call.full, call.patched).filter(
      (change) => change.table === 'session' && listKeysFollowLoad(change, normalized)
    )
    const allowed = [...normalized, ...listKeyChanges.map((change) => `session/${change.field}`)]
    // Only records the load rewrites from what the stored partition says can differ.
    expect(differs.filter((record) => !allowed.includes(record))).toEqual([])
    // Either way the partition loads to main's model.
    expect(reloaded(call.hostId, call.patched)).toBe(reloaded(call.hostId, call.full))
    differs.forEach((record) => differing.add(record))
  }
  return [...differing].sort()
}

const GIT = 'repo-1::/Users/dev/orca'
// The two a switch-off window restores differently from their full save, dropping tab-b or adding
// it (legacy-partition-full-save-hydration.test.ts); the others differ only in records on disk.
const SURFACE_TOMBSTONE = 'legacy surface tombstone on a pane still showing its terminal'
const HIDDEN_ROW = 'row without a tab-bar entry or a terminal'

/** Every legacy fixture's difference per writer; absent is none. */
const PINNED: Readonly<Record<string, Partial<Record<WriterName, readonly string[]>>>> = {
  [HIDDEN_ROW]: {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row without a tab-bar entry or a terminal, selected': {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row without a tab-bar entry, its terminal in a workspace slept at shutdown': {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row without a tab-bar entry, still bound to a terminal': {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row without a tab-bar entry, its terminal only on a relay': {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row without a tab-bar entry, with a sleeping agent': {
    [APPLY]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`],
    [MOVE]: [`entry/${GIT}|$order`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [`entry/${GIT}|$order`, `group/${GIT}|g1`, `terminalEntry/${GIT}|tab-b`]
  },
  'row bound only through its pane, without a tab-bar entry': {
    [APPLY]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      `row/${GIT}|tab-b`,
      `terminalEntry/${GIT}|tab-b`
    ],
    [MOVE]: [`entry/${GIT}|$order`, `row/${GIT}|tab-b`, `terminalEntry/${GIT}|tab-b`],
    [SAVE]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      `row/${GIT}|tab-b`,
      `terminalEntry/${GIT}|tab-b`
    ]
  },
  'legacy row repeating a tab-bar tab’s terminal': {
    [APPLY]: ['layout/tab-legacy', `row/${GIT}|$order`, `row/${GIT}|tab-legacy`],
    [MOVE]: ['layout/tab-legacy', `row/${GIT}|$order`, `row/${GIT}|tab-legacy`],
    [SAVE]: ['layout/tab-legacy', `row/${GIT}|$order`, `row/${GIT}|tab-legacy`]
  },
  'legacy row repeating a tab-bar tab’s terminal, selected': {
    [APPLY]: [
      'layout/tab-legacy',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-legacy`,
      'session/activeTabId',
      'session/activeTabIdByWorktree'
    ],
    [MOVE]: [
      'layout/tab-legacy',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-legacy`,
      'session/activeTabId',
      'session/activeTabIdByWorktree'
    ],
    [SAVE]: [
      'layout/tab-legacy',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-legacy`,
      'session/activeTabId',
      'session/activeTabIdByWorktree'
    ]
  },
  'legacy split row sharing one pane’s terminal with a tab-bar tab': {
    [APPLY]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      'layout/tab-legacy',
      `row/${GIT}|tab-legacy`,
      `terminalEntry/${GIT}|tab-legacy`
    ],
    [MOVE]: [
      `entry/${GIT}|$order`,
      'layout/tab-legacy',
      `row/${GIT}|tab-legacy`,
      `terminalEntry/${GIT}|tab-legacy`
    ],
    [SAVE]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      'layout/tab-legacy',
      `row/${GIT}|tab-legacy`,
      `terminalEntry/${GIT}|tab-legacy`
    ]
  },
  'row terminal differs from its focused pane’s': {
    [APPLY]: [`row/${GIT}|tab-a`],
    [MOVE]: [`row/${GIT}|tab-a`],
    [SAVE]: [`row/${GIT}|tab-a`]
  },
  'row with no terminal while its pane has one': {
    [APPLY]: [`row/${GIT}|tab-a`],
    [MOVE]: [`row/${GIT}|tab-a`],
    [SAVE]: [`row/${GIT}|tab-a`]
  },
  'tab listed by two groups, its tab-bar entry naming the second': {
    [APPLY]: [`group/${GIT}|g1`],
    [SAVE]: [`group/${GIT}|g1`]
  },
  'session from before the tab bar, with an open file': {
    [APPLY]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|$order`,
      `group/${GIT}|1a5387f9-46df-5b0c-807c-4cf31d90223e`,
      'session/tabGroupLayouts',
      'session/tabGroups',
      'session/unifiedTabs',
      `terminalEntry/${GIT}|tab-a`,
      `terminalEntry/${GIT}|tab-b`
    ],
    [MOVE]: [
      `entry/${GIT}|$order`,
      'session/tabGroupLayouts',
      `terminalEntry/${GIT}|tab-a`,
      `terminalEntry/${GIT}|tab-b`
    ],
    [SAVE]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|$order`,
      `group/${GIT}|1a5387f9-46df-5b0c-807c-4cf31d90223e`,
      'session/tabGroupLayouts',
      'session/tabGroups',
      `terminalEntry/${GIT}|tab-b`
    ]
  },
  'session from before the tab bar, a row with no terminal': {
    [APPLY]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|$order`,
      `group/${GIT}|1a5387f9-46df-5b0c-807c-4cf31d90223e`,
      'session/tabGroupLayouts',
      'session/tabGroups',
      'session/unifiedTabs',
      `terminalEntry/${GIT}|tab-a`,
      `terminalEntry/${GIT}|tab-b`
    ],
    [MOVE]: [
      `entry/${GIT}|$order`,
      'session/tabGroupLayouts',
      `terminalEntry/${GIT}|tab-a`,
      `terminalEntry/${GIT}|tab-b`
    ],
    [SAVE]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|$order`,
      `group/${GIT}|1a5387f9-46df-5b0c-807c-4cf31d90223e`,
      'session/tabGroupLayouts',
      'session/tabGroups',
      `terminalEntry/${GIT}|tab-b`
    ]
  },
  [SURFACE_TOMBSTONE]: {
    [APPLY]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      'layout/tab-b',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-b`,
      'session/terminalSurfaceTombstonesByPaneKey',
      'session/terminalTopologyRevisionByRepoId',
      'session/unifiedTabs',
      `terminalEntry/${GIT}|tab-b`
    ],
    [MOVE]: [
      `entry/${GIT}|$order`,
      'layout/tab-b',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-b`,
      'session/terminalSurfaceTombstonesByPaneKey',
      'session/terminalTopologyRevisionByRepoId',
      `terminalEntry/${GIT}|tab-b`
    ],
    [SAVE]: [
      `entry/${GIT}|$order`,
      `group/${GIT}|g1`,
      'layout/tab-b',
      `row/${GIT}|$order`,
      `row/${GIT}|tab-b`,
      'session/terminalSurfaceTombstonesByPaneKey',
      'session/terminalTopologyRevisionByRepoId',
      `terminalEntry/${GIT}|tab-b`
    ]
  },
  'tab-bar label differing from the row title': {
    [APPLY]: [`row/${GIT}|tab-a`],
    [MOVE]: [`row/${GIT}|tab-a`],
    [SAVE]: [`row/${GIT}|tab-a`]
  }
}

describe.each(([APPLY, MOVE, SAVE] as const).map((name) => [name, WRITERS[name]] as const))(
  '%s: touched-records patch vs a full save',
  (writer, write) => {
    it.each(WORKSPACE_LAYOUT_PROFILES.map((profile) => [profile.name, profile] as const))(
      '%s: the same session, key order aside, as its load normalizes nothing',
      (_name, profile) => {
        for (const call of write(profile).flat()) {
          expect(recordsDiffering(call.stored, call.before)).toEqual([])
          expect(stableJson(call.patched)).toBe(stableJson(call.full))
        }
      }
    )

    it.each(LEGACY_WORKSPACE_LAYOUT_PROFILES.map((profile) => [profile.name, profile] as const))(
      '%s: differs only on records the load normalizes',
      (_name, profile) => {
        const calls = write(profile).flat()
        expect(calls.length).toBeGreaterThan(0)
        const differing = differingRecords(calls)
        // Exact both ways: a fixture that converges, or a new divergence, fails here.
        expect(differing).toEqual(PINNED[profile.name]?.[writer] ?? [])
      }
    )
  }
)
