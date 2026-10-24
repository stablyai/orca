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
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { droppedTabBarEntries, terminalTabBarEntries } from './window-save-raw-session-divergence'
import { compactFieldChanges, type FieldChange } from './window-save-divergence-values'

/** Set by evidence runs: each divergence is appended there as one JSON line. */
const LOG_PATH_ENV = 'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG'
const MAX_PATHS = 12
/** A pane's terminal binding and resume record: main writes them on every spawn and capture. */
const BINDING_FIELDS = new Set(['ptyId', 'incarnationId', 'sleeping', 'resume'])

/** `values`: main's and the save's values of each changed field, content left out. */
export type WindowSaveDivergence = { workspace: string; paths: string[]; values?: FieldChange[] }

/** One report path, with the field values behind a `changed` one. */
type Difference = { path: string; changes?: (FieldChange & { kind: string })[] }

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

function fieldOf(item: unknown, field: string): unknown {
  return field === 'value' || typeof item !== 'object' || !item
    ? item
    : Object.entries(item).find(([key]) => key === field)?.[1]
}

/** Values logged beside a changed record's own fields, by its id and changed fields. */
type Alongside = (id: string, fields: string[]) => Omit<FieldChange, 'record'>[]

function diffKeyed(
  prefix: string,
  before: Map<string, unknown>,
  after: Map<string, unknown>,
  alongside?: Alongside
): Difference[] {
  const paths: Difference[] = []
  for (const [id, item] of after) {
    if (!before.has(id)) {
      paths.push({ path: `${prefix} ${id} added` })
      continue
    }
    const was = before.get(id)
    const fields = changedFields(was, item)
    if (fields.length > 0) {
      const record = `${prefix} ${id}`
      paths.push({
        path: `${record} changed: ${fields.join(', ')}`,
        changes: [
          ...fields.map((field) => ({
            field,
            before: fieldOf(was, field),
            after: fieldOf(item, field)
          })),
          ...(alongside?.(id, fields) ?? [])
        ].map((change) => ({ kind: prefix, record, ...change }))
      })
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      paths.push({ path: `${prefix} ${id} removed` })
    }
  }
  return paths
}

function listById<T>(items: readonly T[] | undefined, id: (item: T) => string) {
  return new Map<string, unknown>((items ?? []).map((item) => [id(item), item]))
}

/** A terminal tab's panes in tree order with the terminal each is bound to, null while unbound. */
function paneBindings(workspace: WorkspaceLayout, tabId: string) {
  const tab = workspace.tabs.find((candidate) => candidate.id === tabId)
  const leafIds: string[] = []
  const visit = (node: TerminalPaneLayoutNode | null): void => {
    if (node?.type === 'leaf') {
      leafIds.push(node.leafId)
    } else if (node) {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(tab?.kind === 'terminal' ? tab.panes.root : null)
  return leafIds.map((leafId) => ({ leafId, ptyId: workspace.leaves?.[leafId]?.ptyId ?? null }))
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
): Difference[] {
  if (!hasContent(before) || !hasContent(after)) {
    return hasContent(before) || hasContent(after)
      ? [{ path: hasContent(after) ? 'workspace added' : 'workspace removed' }]
      : []
  }
  const leaves = unboundLeaves(before.leaves, after.leaves)
  const paths: Difference[] = [
    ...diffKeyed(
      'group',
      listById(before.groups, (g) => g.id),
      listById(after.groups, (g) => g.id)
    ),
    ...diffKeyed(
      'tab',
      listById(before.tabs, (t) => t.id),
      listById(after.tabs, (t) => t.id),
      // Bindings are main's to write, so they never make a path; they show who holds a changed pane.
      (id, fields) =>
        fields.includes('panes')
          ? [{ field: 'ptys', before: paneBindings(before, id), after: paneBindings(after, id) }]
          : []
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
  const wasTree = groupTreeOf(before)
  const nowTree = groupTreeOf(after)
  if (stableJson(wasTree) !== stableJson(nowTree)) {
    paths.push({
      path: 'group layout changed',
      changes: [
        {
          kind: 'group layout',
          record: 'group layout',
          field: 'tree',
          before: wasTree,
          after: nowTree
        }
      ]
    })
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
    const differences: Difference[] = [
      ...diffWorkspaceLayouts(was?.workspaces[workspace], now?.workspaces[workspace]),
      ...(rawPaths.get(workspace) ?? []).map((path) => ({ path }))
    ].slice(0, MAX_PATHS)
    if (differences.length > 0) {
      const changes = differences.flatMap((difference) => difference.changes ?? [])
      result.push({
        workspace,
        paths: differences.map((difference) => difference.path),
        ...(changes.length > 0 ? { values: compactFieldChanges(changes) } : {})
      })
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
