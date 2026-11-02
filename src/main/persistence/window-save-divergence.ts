// A layout-owner build's drift check: every tab change reaches main as a command and main keeps
// its own layout over a window save, so a save whose layout differs from main's model shows a
// change main never got as a command. Report-only, and only when its log is set (evidence runs);
// it never alters, fails or delays the write. Records main keeps through its own writes (pane
// bindings, resume records, default-tab marks, closed-tab records, terminal row owners,
// client-hosted browser pages, the topology revision) are not compared: a save that has not
// caught up with them asks main for nothing. Deleted with the old path (phase F).

import { appendFileSync } from 'node:fs'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type {
  WorkspaceLayout,
  WorkspaceLayoutModel
} from '../../shared/workspace-layout/workspace-layout-model'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { droppedTabBarEntries, terminalTabBarEntries } from './window-save-raw-session-divergence'

/** Set by evidence runs: each divergence is appended there as one JSON line. */
const LOG_PATH_ENV = 'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG'
const MAX_PATHS = 12
/** A pane's terminal binding and resume record: main writes them on every spawn and capture. */
const BINDING_FIELDS = new Set(['ptyId', 'incarnationId', 'sleeping'])

export type WindowSaveDivergence = { workspace: string; paths: string[] }

/** Main's layout model of one partition, as the session holds it. */
export function layoutModelOf(
  session: WorkspaceSessionState | null | undefined,
  hostId: ExecutionHostId
): WorkspaceLayoutModel | null {
  return session
    ? loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()).layout
    : null
}

/** The fields two copies of one record differ in. */
function changedFields(before: unknown, after: unknown): string[] {
  if (typeof before !== 'object' || typeof after !== 'object' || !before || !after) {
    return stableJson(before ?? null) === stableJson(after ?? null) ? [] : ['value']
  }
  const was = new Map(Object.entries(before))
  const now = new Map(Object.entries(after))
  return [...new Set([...was.keys(), ...now.keys()])].filter(
    (key) => stableJson(was.get(key) ?? null) !== stableJson(now.get(key) ?? null)
  )
}

function diffKeyed(
  prefix: string,
  before: Map<string, unknown>,
  after: Map<string, unknown>
): string[] {
  const paths: string[] = []
  for (const [id, item] of after) {
    if (!before.has(id)) {
      paths.push(`${prefix} ${id} added`)
      continue
    }
    const fields = changedFields(before.get(id), item)
    if (fields.length > 0) {
      paths.push(`${prefix} ${id} changed: ${fields.join(', ')}`)
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      paths.push(`${prefix} ${id} removed`)
    }
  }
  return paths
}

function listById<T>(items: readonly T[] | undefined, id: (item: T) => string) {
  return new Map<string, unknown>((items ?? []).map((item) => [id(item), item]))
}

function recordById(items: Readonly<Record<string, unknown>> | undefined) {
  return new Map<string, unknown>(Object.entries(items ?? {}))
}

function bindingOnly(leaf: unknown): boolean {
  return (
    typeof leaf === 'object' &&
    leaf !== null &&
    Object.keys(leaf).every((key) => BINDING_FIELDS.has(key))
  )
}

/** Each copy's panes without those whose only change is their binding, first or last included. */
function unboundLeaves(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>> | undefined
): { was: Map<string, unknown>; now: Map<string, unknown> } {
  const was = recordById(before)
  const now = recordById(after)
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(id)
    const next = now.get(id)
    const changed = old === undefined || next === undefined ? null : changedFields(old, next)
    if (
      changed
        ? changed.length > 0 && changed.every((field) => BINDING_FIELDS.has(field))
        : bindingOnly(old ?? next)
    ) {
      was.delete(id)
      now.delete(id)
    }
  }
  return { was, now }
}

/**
 * Whether a workspace holds anything. The Loader makes one for every key a save names and places a
 * stored closed-tab record by worktree id into it, so neither makes one by itself.
 */
function hasContent(workspace: WorkspaceLayout | undefined): workspace is WorkspaceLayout {
  return Boolean(
    workspace &&
    (workspace.tabs.length > 0 ||
      workspace.groups.length > 0 ||
      workspace.groupLayout ||
      [workspace.editorFiles, workspace.browserTabs, workspace.editorViews, workspace.leaves].some(
        (items) => items && Object.keys(items).length > 0
      ))
  )
}

/** A lone group with no stored tree is that group's leaf, as main's own save writes it. */
function groupTreeOf(workspace: WorkspaceLayout): TabGroupLayoutNode | null {
  const [only, ...rest] = workspace.groups
  return (
    workspace.groupLayout ?? (only && rest.length === 0 ? { type: 'leaf', groupId: only.id } : null)
  )
}

/** Where one workspace of two copies of main's model differs; empty when nothing. */
function diffWorkspaceLayouts(
  before: WorkspaceLayout | undefined,
  after: WorkspaceLayout | undefined
): string[] {
  if (!hasContent(before) || !hasContent(after)) {
    return hasContent(before) || hasContent(after)
      ? [hasContent(after) ? 'workspace added' : 'workspace removed']
      : []
  }
  const leaves = unboundLeaves(before.leaves, after.leaves)
  const paths = [
    ...diffKeyed(
      'group',
      listById(before.groups, (g) => g.id),
      listById(after.groups, (g) => g.id)
    ),
    ...diffKeyed(
      'tab',
      listById(before.tabs, (t) => t.id),
      listById(after.tabs, (t) => t.id)
    ),
    ...diffKeyed(
      'file',
      listById(before.editorFiles, (f) => f.filePath),
      listById(after.editorFiles, (f) => f.filePath)
    ),
    ...diffKeyed('editor view', recordById(before.editorViews), recordById(after.editorViews)),
    ...diffKeyed(
      'browser',
      listById(before.browserTabs, (b) => b.id),
      listById(after.browserTabs, (b) => b.id)
    ),
    ...diffKeyed('leaf', leaves.was, leaves.now)
  ]
  if (stableJson(groupTreeOf(before)) !== stableJson(groupTreeOf(after))) {
    paths.push('group layout changed')
  }
  return paths
}

/**
 * Each workspace whose part of main's model differs between two copies of one partition, plus
 * `rawPaths`: what only the stored session itself shows, by workspace.
 */
export function windowSaveDivergences(
  was: WorkspaceLayoutModel | null,
  now: WorkspaceLayoutModel | null,
  rawPaths: ReadonlyMap<string, string[]> = new Map()
): WindowSaveDivergence[] {
  const workspaces = new Set([
    ...[was, now].flatMap((model) => (model ? Object.keys(model.workspaces) : [])),
    ...rawPaths.keys()
  ])
  const result: WindowSaveDivergence[] = []
  // Ignored, as main's own writes: pane bindings, resume records, default-tab marks, closed-tab records, row owners,
  // clientHostedBrowserPagesByWorkspace and the topology revision.
  for (const workspace of workspaces) {
    const paths = [
      ...diffWorkspaceLayouts(was?.workspaces[workspace], now?.workspaces[workspace]),
      ...(rawPaths.get(workspace) ?? [])
    ]
    if (paths.length > 0) {
      result.push({ workspace, paths: paths.slice(0, MAX_PATHS) })
    }
  }
  return result
}

function report(source: string, partition: ExecutionHostId, divergence: WindowSaveDivergence) {
  console.warn('[layout-owner] window save changed main layout:', source, divergence)
  const logPath = process.env[LOG_PATH_ENV]
  if (!logPath) {
    return
  }
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: Date.now(), source, partition, ...divergence })}\n`
    )
  } catch (error) {
    console.warn('[layout-owner] save divergence log write failed:', error)
  }
}

/**
 * Reports where the window's `save` (a whole session, or a patch laid over `stored`) differs from
 * main's layout model of `stored`. A paired server's partition is skipped: its layout is the
 * server's, mirrored by the window. Nothing here can fail the save: errors are only logged.
 */
export function reportWindowSaveDrift(
  stored: WorkspaceSessionState,
  save: WorkspaceSessionState,
  hostId: string | null | undefined,
  source: string
): void {
  if (!process.env[LOG_PATH_ENV]) {
    return
  }
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    return
  }
  try {
    const was = layoutModelOf(stored, partition)
    const now = layoutModelOf(save, partition)
    const rawPaths = new Map<string, string[]>()
    droppedTabBarEntries(terminalTabBarEntries(stored), save, rawPaths)
    for (const divergence of windowSaveDivergences(was, now, rawPaths)) {
      report(source, partition, divergence)
    }
  } catch (error) {
    console.warn('[layout-owner] save divergence check failed:', error)
  }
}
