// Layout-owner build: what main runs after a client's startPane, wake or restartPane is written.
// Every start goes through main's one restored-pane starter, so racing triggers start one terminal.

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

/**
 * Stops the terminals a command replaces, before its write, through the existing stop path. Never
 * silent: a terminal that would not stop is logged, and its pane keeps it and starts nothing.
 */
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

/**
 * Starts each pane the written command names; its replaced terminals stopped before the write.
 * Never silent: the starter shows a failed start on the pane. A wake keeps its records: the start
 * resumes from them and keeps them in the pane-owned form, so a host crash resumes the agent again.
 */
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
