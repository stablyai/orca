import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../shared/workspace-layout/terminal-tab-types'
import {
  layoutContainsLeafId,
  resolveRootlessTerminalLayoutLeafId
} from '../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { sanitizeTerminalLayoutPaneTitles } from '../../shared/workspace-layout/terminal-topology/terminal-pane-title-sanitization'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

function readRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function keepNewerPaneTitles(
  stored: TerminalLayoutSnapshot,
  layout: TerminalLayoutSnapshot
): TerminalLayoutSnapshot {
  let titles: TerminalLayoutSnapshot['titlesByLeafId']
  let revisions: TerminalLayoutSnapshot['paneTitleRevisionByLeafId']
  const savedLeafIds = new Set([
    ...Object.keys(stored.titlesByLeafId ?? {}),
    ...Object.keys(stored.paneTitleRevisionByLeafId ?? {})
  ])
  for (const leafId of savedLeafIds) {
    const storedRevision = readRevision(stored.paneTitleRevisionByLeafId?.[leafId])
    const incomingRevision = readRevision(layout.paneTitleRevisionByLeafId?.[leafId])
    const savedTitle = stored.titlesByLeafId?.[leafId]
    if (
      incomingRevision > storedRevision ||
      (incomingRevision === storedRevision && savedTitle === layout.titlesByLeafId?.[leafId])
    ) {
      continue
    }
    const leafExists = layout.root
      ? layoutContainsLeafId(layout.root, leafId)
      : resolveRootlessTerminalLayoutLeafId(layout) === leafId
    if (!leafExists) {
      continue
    }
    if (savedTitle !== layout.titlesByLeafId?.[leafId]) {
      titles ??= { ...layout.titlesByLeafId }
      if (savedTitle === undefined) {
        delete titles[leafId]
      } else {
        titles[leafId] = savedTitle
      }
    }
    if (storedRevision > incomingRevision) {
      revisions ??= { ...layout.paneTitleRevisionByLeafId }
      revisions[leafId] = storedRevision
    }
  }
  if (!titles && !revisions) {
    return layout
  }
  const { titlesByLeafId, ...rest } = layout
  const nextTitles = titles ?? titlesByLeafId
  return {
    ...rest,
    ...(nextTitles && Object.keys(nextTitles).length > 0 ? { titlesByLeafId: nextTitles } : {}),
    ...(revisions ? { paneTitleRevisionByLeafId: revisions } : {})
  }
}

/** Window layout snapshots can outlive a rename. Merge title revisions independently of geometry. */
export function windowSaveKeepingPaneTitles<T extends WorkspaceSessionPatch>(
  stored: WorkspaceSessionState,
  save: T,
  hostId?: string | null
): T {
  const layouts = save.terminalLayoutsByTabId
  if (!layouts || (hostId && parseExecutionHostId(hostId)?.kind === 'runtime')) {
    return save
  }
  let nextLayouts: typeof layouts | undefined
  let tabsById: Map<string, TerminalTab> | undefined
  for (const [tabId, layout] of Object.entries(layouts)) {
    const prior = stored.terminalLayoutsByTabId[tabId]
    if (!prior || prior === layout || (!prior.titlesByLeafId && !prior.paneTitleRevisionByLeafId)) {
      continue
    }
    const merged = keepNewerPaneTitles(prior, layout)
    if (merged === layout) {
      continue
    }
    tabsById ??= new Map(
      Object.values(save.tabsByWorktree ?? stored.tabsByWorktree).flatMap((tabs) =>
        tabs.map((tab) => [tab.id, tab] as const)
      )
    )
    const tab = tabsById.get(tabId)
    nextLayouts ??= { ...layouts }
    nextLayouts[tabId] = tab ? sanitizeTerminalLayoutPaneTitles(merged, tab) : merged
  }
  return nextLayouts ? { ...save, terminalLayoutsByTabId: nextLayouts } : save
}
