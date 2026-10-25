// Route start/wake/restart effects through the one restored-pane starter so racing triggers share a terminal.

import type {
  LayoutEffects,
  LayoutCommand
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { RestoredPane, StartedPty } from './restored-pane-start'

/** Main's restored-pane starter: the pane's terminal, or null once main no longer holds it. */
export type LayoutPaneStart = (pane: RestoredPane) => Promise<StartedPty | null>

const STARTING_COMMANDS: ReadonlySet<LayoutCommand['type']> = new Set([
  'startPane',
  'wake',
  'restartPane'
])

/** Whether main runs this command's effects; a create or split starts through its own path. */
export function startsPanes(command: Pick<LayoutCommand, 'type'>): boolean {
  return STARTING_COMMANDS.has(command.type)
}

/** Stop replacements before layout writes; log failures and retain the old binding without starting another terminal. */
export function stopReplacedTerminals(
  ptyIds: readonly string[],
  stop: (ptyId: string) => boolean
): boolean {
  const unstopped = ptyIds.filter((ptyId) => !stop(ptyId))
  if (unstopped.length > 0) {
    console.warn('[layout] a restart could not stop its terminal; nothing started', unstopped)
    return false
  }
  return true
}

/** Start written panes through the failure-reporting starter; retain wake records in pane-owned form so host crashes can resume again. */
export function runLayoutPaneStarts(
  command: Pick<LayoutCommand, 'type' | 'workspace'>,
  effects: LayoutEffects,
  start: LayoutPaneStart
): void {
  if (!startsPanes(command)) {
    return
  }
  for (const paneKey of effects.startPaneKeys) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const pane = { worktreeId: command.workspace, tabId: parsed.tabId, leafId: parsed.leafId }
    // The starter shows a failed start on the pane.
    void start(pane).catch(() => {})
  }
}
