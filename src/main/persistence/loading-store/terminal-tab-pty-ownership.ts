import type { TerminalTab } from '../../../shared/terminal-tab-types'

type LeafPtyIds = Readonly<Record<string, string>> | undefined

/** Preserve the first-pane tab PTY across sibling binds; only absence or this leaf's old PTY permits replacement. */
export function tabRowPtyIdAfterLeafBinding(
  tab: Pick<TerminalTab, 'ptyId'>,
  ptyIdsByLeafId: LeafPtyIds,
  leafId: string,
  ptyId: string
): string {
  const current = tab.ptyId
  if (current === null || current === ptyIdsByLeafId?.[leafId]) {
    return ptyId
  }
  return current
}
