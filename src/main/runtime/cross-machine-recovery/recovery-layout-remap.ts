import path from 'node:path'
import type {
  RecoveryImportIdMap,
  RecoveryLayout,
  RecoveryPathMapping
} from '../../../shared/cross-machine-recovery-descriptor'
import type { RecoveryWorkspaceFragment } from '../../../shared/cross-machine-recovery-session-ops'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'

export type RecoveryRemapContext = {
  worktreeId: string
  checkoutPath: string
  sourceWorkspacePath: string
  now: number
  mintId: () => string
}

export type RemappedRecoveryLayout = {
  fragment: RecoveryWorkspaceFragment
  idMap: RecoveryImportIdMap
}

function hasPathPrefix(value: string, prefix: string): boolean {
  if (value === prefix) {
    return true
  }
  const trimmed = prefix.replace(/[\\/]+$/, '')
  return value.startsWith(`${trimmed}/`) || value.startsWith(`${trimmed}\\`)
}

/** Rewrites a source-host path through the first matching prefix; unmapped paths are dropped. */
export function remapRecoveryPath(
  value: string,
  pathMap: readonly RecoveryPathMapping[]
): string | undefined {
  const mapping = pathMap.find(({ from }) => hasPathPrefix(value, from))
  if (!mapping) {
    return undefined
  }
  const rest = value.slice(mapping.from.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '')
  return rest ? path.join(mapping.to, ...rest.split(/[\\/]/)) : mapping.to
}

/** Joins a portable relative path under the checkout; refuses anything that escapes it. */
export function resolveCheckoutRelativePath(
  checkoutPath: string,
  relativePath: string
): string | undefined {
  const joined = path.resolve(checkoutPath, ...relativePath.split(/[\\/]/))
  const back = path.relative(checkoutPath, joined)
  return back === '' || back.startsWith('..') || path.isAbsolute(back) ? undefined : joined
}

function sourceRelativePath(entityId: string, sourceWorkspacePath: string): string | undefined {
  if (!hasPathPrefix(entityId, sourceWorkspacePath)) {
    return undefined
  }
  const trimmed = sourceWorkspacePath.replace(/[\\/]+$/, '')
  return (
    entityId
      .slice(trimmed.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/') || undefined
  )
}

function remapLeafTree(
  node: TerminalPaneLayoutNode,
  leaves: Record<string, string>
): TerminalPaneLayoutNode | null {
  if (node.type === 'leaf') {
    const leafId = leaves[node.leafId]
    return leafId ? { type: 'leaf', leafId } : null
  }
  const first = remapLeafTree(node.first, leaves)
  const second = remapLeafTree(node.second, leaves)
  return first && second ? { ...node, first, second } : (first ?? second)
}

function collectLeafIds(node: TerminalPaneLayoutNode | null, out: string[]): string[] {
  if (node?.type === 'leaf') {
    out.push(node.leafId)
  } else if (node) {
    collectLeafIds(node.first, out)
    collectLeafIds(node.second, out)
  }
  return out
}

function remapGroupTree(
  node: TabGroupLayoutNode,
  groups: Record<string, string>
): TabGroupLayoutNode | null {
  if (node.type === 'leaf') {
    const groupId = groups[node.groupId]
    return groupId ? { type: 'leaf', groupId } : null
  }
  const first = remapGroupTree(node.first, groups)
  const second = remapGroupTree(node.second, groups)
  return first && second ? { ...node, first, second } : (first ?? second)
}

function mapped(map: Record<string, string>, id: string | null | undefined): string | null {
  return id ? (map[id] ?? null) : null
}

/** Regenerates every tab, group, leaf and browser id and rebases paths onto the local checkout. */
export function remapRecoveryLayout(
  layout: RecoveryLayout,
  ctx: RecoveryRemapContext
): RemappedRecoveryLayout {
  const idMap: RecoveryImportIdMap = { tabs: {}, groups: {}, leaves: {}, browsers: {} }
  const terminalTabs: TerminalTab[] = []
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const source of layout.terminalTabs) {
    const id = ctx.mintId()
    idMap.tabs[source.id] = id
    // Why: a dormant binding launches only through Resume; a kept launchAgent would let tab
    // activation (desktop or mobile) start a fresh agent without the recovered session.
    const { startupCwd: _sourceCwd, launchAgent: _launchAgent, ...rest } = source
    void _sourceCwd
    void _launchAgent
    const relativeCwd = layout.startupCwdRelative[source.id]
    const startupCwd =
      relativeCwd === undefined
        ? undefined
        : relativeCwd === ''
          ? ctx.checkoutPath
          : resolveCheckoutRelativePath(ctx.checkoutPath, relativeCwd)
    terminalTabs.push({
      ...rest,
      id,
      ptyId: null,
      worktreeId: ctx.worktreeId,
      ...(startupCwd ? { startupCwd } : {})
    })
    const sourceLayout = layout.terminalLayouts[source.id]
    if (!sourceLayout) {
      continue
    }
    for (const leafId of collectLeafIds(sourceLayout.root, [])) {
      idMap.leaves[leafId] = ctx.mintId()
    }
    const chatLeafId = mapped(idMap.leaves, sourceLayout.chatLeafId)
    const titlesByLeafId = Object.fromEntries(
      Object.entries(sourceLayout.titlesByLeafId ?? {}).flatMap(([leafId, title]) =>
        idMap.leaves[leafId] ? [[idMap.leaves[leafId], title]] : []
      )
    )
    terminalLayoutsByTabId[id] = {
      root: sourceLayout.root ? remapLeafTree(sourceLayout.root, idMap.leaves) : null,
      activeLeafId: mapped(idMap.leaves, sourceLayout.activeLeafId),
      expandedLeafId: mapped(idMap.leaves, sourceLayout.expandedLeafId),
      ...(chatLeafId ? { chatLeafId } : {}),
      ...(Object.keys(titlesByLeafId).length > 0 ? { titlesByLeafId } : {})
    }
  }

  const openFiles: PersistedOpenFile[] = []
  const filePathByRelative = new Map<string, string>()
  for (const editor of layout.editors) {
    const filePath = resolveCheckoutRelativePath(ctx.checkoutPath, editor.relativePath)
    if (!filePath) {
      continue
    }
    filePathByRelative.set(editor.relativePath, filePath)
    openFiles.push({
      filePath,
      relativePath: editor.relativePath,
      worktreeId: ctx.worktreeId,
      language: editor.language,
      ...(editor.isPreview !== undefined ? { isPreview: editor.isPreview } : {}),
      ...(editor.readOnly !== undefined ? { readOnly: editor.readOnly } : {})
    })
  }

  const browserWorkspaces: BrowserWorkspace[] = []
  const browserPagesByWorkspace: Record<string, BrowserPage[]> = {}
  for (const browser of layout.browsers) {
    const id = ctx.mintId()
    idMap.browsers[browser.id] = id
    const pages: BrowserPage[] = browser.pages.map((page) => {
      const pageId = ctx.mintId()
      idMap.browsers[page.id] = pageId
      return {
        id: pageId,
        workspaceId: id,
        worktreeId: ctx.worktreeId,
        url: page.url,
        title: page.title ?? page.url,
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: ctx.now
      }
    })
    const active = pages.find((page) => page.id === mapped(idMap.browsers, browser.activePageId))
    const shown = active ?? pages[0]
    browserPagesByWorkspace[id] = pages
    browserWorkspaces.push({
      id,
      worktreeId: ctx.worktreeId,
      ...(browser.label !== undefined ? { label: browser.label } : {}),
      activePageId: shown?.id ?? null,
      pageIds: pages.map((page) => page.id),
      url: shown?.url ?? 'about:blank',
      title: shown?.title ?? '',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: ctx.now
    })
  }

  for (const group of layout.groups) {
    idMap.groups[group.id] = ctx.mintId()
  }
  const unifiedTabs: Tab[] = []
  for (const tab of layout.tabs) {
    const groupId = idMap.groups[tab.groupId]
    const entityId =
      tab.contentType === 'terminal'
        ? idMap.tabs[tab.entityId]
        : tab.contentType === 'browser'
          ? idMap.browsers[tab.entityId]
          : tab.contentType === 'editor'
            ? filePathByRelative.get(
                sourceRelativePath(tab.entityId, ctx.sourceWorkspacePath) ?? ''
              )
            : undefined
    if (!groupId || !entityId) {
      continue
    }
    // Why: terminal and browser tabs may reuse their entity id as the tab id; keep that aliasing.
    const id = tab.contentType === 'editor' || tab.id === tab.entityId ? entityId : ctx.mintId()
    idMap.tabs[tab.id] = id
    unifiedTabs.push({ ...tab, id, entityId, groupId, worktreeId: ctx.worktreeId })
  }
  const tabGroups: TabGroup[] = layout.groups.map((group) => {
    const tabOrder = group.tabOrder.flatMap((id) => (idMap.tabs[id] ? [idMap.tabs[id]] : []))
    const recentTabIds = group.recentTabIds?.flatMap((id) =>
      idMap.tabs[id] ? [idMap.tabs[id]] : []
    )
    return {
      id: idMap.groups[group.id],
      worktreeId: ctx.worktreeId,
      activeTabId: mapped(idMap.tabs, group.activeTabId),
      tabOrder,
      ...(recentTabIds ? { recentTabIds } : {})
    }
  })

  const activeFileId = layout.activeEditorRelativePath
    ? (filePathByRelative.get(layout.activeEditorRelativePath) ?? null)
    : null
  return {
    idMap,
    fragment: {
      worktreeId: ctx.worktreeId,
      terminalTabs,
      terminalLayoutsByTabId,
      unifiedTabs,
      tabGroups,
      tabGroupLayout: layout.groupLayout ? remapGroupTree(layout.groupLayout, idMap.groups) : null,
      activeGroupId: mapped(idMap.groups, layout.activeGroupId),
      openFiles,
      activeFileId,
      browserWorkspaces,
      browserPagesByWorkspace,
      activeBrowserTabId: mapped(idMap.browsers, layout.activeBrowserId),
      activeTabType: layout.activeTabType,
      activeTabId: mapped(idMap.tabs, layout.activeTabId)
    }
  }
}
