import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'

/** `titles` in tab and pane order, null for a pane with none; the same layout when all are null. */
export function withLiveTitles(
  layout: PublishedWorkspaceLayout,
  titles: (string | null)[]
): PublishedWorkspaceLayout {
  if (titles.every((title) => title === null)) {
    return layout
  }
  let index = 0
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map((pane) => {
                const liveTitle = titles[index++]
                return liveTitle === null ? pane : { ...pane, liveTitle }
              })
            }
          }
        : tab
    )
  }
}

/** Collect titles in the same tab/pane order used by the ordinary live overlay. */
export function paneLiveTitlesOf(
  layout: PublishedWorkspaceLayout,
  source: { liveTitle: (ptyId: string) => string | null }
): (string | null)[] {
  return layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).map((pane) => (pane.ptyId ? source.liveTitle(pane.ptyId) : null))
  )
}
