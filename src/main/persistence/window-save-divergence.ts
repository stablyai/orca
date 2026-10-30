// Optional report-only drift logging excludes runtime-owned fields that legitimately outrun renderer snapshots.

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

const LOG_PATH_ENV = 'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG'
const MAX_PATHS = 12
const BINDING_FIELDS = new Set(['ptyId', 'incarnationId', 'sleeping', 'resume'])

export type WindowSaveDivergence = { workspace: string; paths: string[]; values?: FieldChange[] }

type Difference = { path: string; changes?: (FieldChange & { kind: string })[] }

export function layoutModelOf(
  session: WorkspaceSessionState | null | undefined,
  hostId: ExecutionHostId
): WorkspaceLayoutModel | null {
  return session
    ? loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()).layout
    : null
}

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

/** Exclude binding-only changes from both pane sets. */
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

/** Loader-created placeholders and closed-tab evidence alone do not establish workspace content. */
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

/** Reconstruct a missing lone-group tree like persistence does. */
function groupTreeOf(workspace: WorkspaceLayout): TabGroupLayoutNode | null {
  const [only, ...rest] = workspace.groups
  return (
    workspace.groupLayout ?? (only && rest.length === 0 ? { type: 'leaf', groupId: only.id } : null)
  )
}

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
      // Bindings identify changed panes but must not create drift paths themselves.
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

/** Include raw-session differences hidden by layout normalization. */
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

/** Compare without affecting saves; paired-server partitions retain server-owned layout authority. */
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
