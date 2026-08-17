import type { Project } from '../../../../shared/project-types'
import type { IPtyProvider, PtyProcessInfo } from '../../types'
import type { HerdrProjectHostGraph } from './herdr-runtime-manager'
import {
  HerdrRuntimeError,
  type HerdrHostTransport,
  type HerdrTerminalController
} from './herdr-runtime-contract'

export type HerdrPtyIdentity = {
  version?: 2
  hostId: string
  projectId: string
  worktreeId: string
  tabId: string
  leafId: string
  paneId?: string
}

export type HerdrPtyTarget = {
  activateHerdr?: () => void | Promise<void>
  legacyMigrationWorktreeIds?: string[]
  project: Project
  graph: HerdrProjectHostGraph
  identity: HerdrPtyIdentity
}

export type HerdrPtyBinding = {
  id: string
  sessionName: string
  paneId: string
  identity: HerdrPtyIdentity
  /** Stable per-binding owner incarnation, minted at bind time; the owner
   *  fence compares spawn results and inventory against it, so it must not
   *  track volatile state like the pane revision. */
  incarnationId: string
  controller: HerdrTerminalController
  transport: HerdrHostTransport
  cwd: string
  cols: number
  rows: number
  sequenceChars: number
  snapshot: string
  detached: boolean
  unsubscribe: (() => void)[]
}

export type HerdrPaneProcessInfo = {
  shell_pid?: number
  foreground_processes: { name: string; cwd?: string }[]
}

export type HerdrPaneSwapOptions = {
  direction?: 'left' | 'right' | 'up' | 'down'
  source_pane_id?: string
  target_pane_id?: string
}

export type HerdrPaneMoveDestination =
  | {
      type: 'tab'
      tab_id: string
      split: 'right' | 'down'
      target_pane_id?: string
      ratio?: number
      focus?: boolean
    }
  | {
      type: 'new_tab'
      workspace_id?: string
      label?: string
      focus?: boolean
    }
  | {
      type: 'new_workspace'
      label?: string
      tab_label?: string
      focus?: boolean
    }

export type HerdrPaneMoveResult = {
  changed: boolean
  pane_id: string
  previous_pane_id: string
  previous_tab_id: string
  previous_workspace_id: string
  focused_pane_id: string
  created_tab?: { tab_id: string; workspace_id: string; label: string } | null
  created_workspace?: { workspace_id: string; label: string } | null
  closed_tab_id?: string | null
  closed_workspace_id?: string | null
}

export function findLegacyMigrationBlockers(
  processes: PtyProcessInfo[],
  worktreeIds: readonly string[]
): string[] {
  const projectWorktrees = new Set(worktreeIds)
  return processes
    .filter((process) => process.worktreeId && projectWorktrees.has(process.worktreeId))
    .map((process) => process.id)
}

export async function assertHerdrMigrationReady(
  target: HerdrPtyTarget,
  fallback?: IPtyProvider
): Promise<void> {
  if (!target.activateHerdr || !target.legacyMigrationWorktreeIds) {
    return
  }
  if (!fallback) {
    return
  }
  const blockers = findLegacyMigrationBlockers(
    await fallback.listProcesses(),
    target.legacyMigrationWorktreeIds
  )
  if (blockers.length > 0) {
    throw new HerdrRuntimeError(
      'migration_blocked',
      `Close live Orca terminals before migrating to Herdr: ${blockers.join(', ')}`
    )
  }
}
