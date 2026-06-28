/** A workspace tab of any kind, normalized from the runtime's mobile-session
 *  tab union into the few fields the TUI needs to list and view it. */
export type SessionTabKind = 'terminal' | 'file' | 'markdown' | 'browser'

export type SessionTab = {
  worktreeId: string
  /** Stable tab id (used for session.tabs.activate / markdown.readTab). */
  id: string
  kind: SessionTabKind
  title: string
  /** Terminal handle for readAnsi, when this is a ready terminal tab. */
  terminalHandle: string | null
  /** Source path for file/markdown tabs (files.read). */
  relativePath: string | null
  /** URL for browser tabs. */
  url: string | null
}

/** A raw tab from session.tabs.list(All) — loosely typed; we read only the
 *  fields we need and tolerate the rest. */
export type RawTab = {
  type?: string
  id?: unknown
  title?: unknown
  status?: string
  terminal?: unknown
  relativePath?: unknown
  sourceRelativePath?: unknown
  url?: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function kindOf(type: string | undefined): SessionTabKind {
  return type === 'file' || type === 'markdown' || type === 'browser' ? type : 'terminal'
}

/** Normalize a worktree's raw tabs into SessionTabs (dropping any without an id). */
export function toSessionTabs(worktreeId: string, tabs: readonly RawTab[]): SessionTab[] {
  const out: SessionTab[] = []
  for (const tab of tabs) {
    const id = str(tab.id)
    if (!id) {
      continue
    }
    const kind = kindOf(tab.type)
    out.push({
      worktreeId,
      id,
      kind,
      title: str(tab.title) || defaultTitle(kind),
      terminalHandle:
        kind === 'terminal' && tab.status === 'ready' ? str(tab.terminal) || null : null,
      relativePath: str(tab.relativePath) || str(tab.sourceRelativePath) || null,
      url: kind === 'browser' ? str(tab.url) || null : null
    })
  }
  return out
}

function defaultTitle(kind: SessionTabKind): string {
  return kind === 'terminal' ? 'shell' : kind
}

/** A single-width glyph hinting a tab's kind, shared by the renderer and the
 *  tab-strip hit-test so their label widths match. */
export function tabGlyph(kind: SessionTabKind): string {
  if (kind === 'file') {
    return '◇'
  }
  if (kind === 'markdown') {
    return '✎'
  }
  if (kind === 'browser') {
    return '◍'
  }
  return '❯'
}
