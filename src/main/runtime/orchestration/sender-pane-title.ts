import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { SenderNamingLayout } from './orchestration-sender-name'

/** Split-tab titles name the focused pane; other split panes need user titles. Single-pane tabs use their own tab titles. */
export function splitPaneTitle(
  layout: SenderNamingLayout | undefined,
  paneKey: string | null
): string | null | undefined {
  if (layout?.root?.type !== 'split') {
    return undefined
  }
  const leafId = paneKey ? parsePaneKey(paneKey)?.leafId : undefined
  return (leafId && layout.titlesByLeafId?.[leafId]) || null
}
