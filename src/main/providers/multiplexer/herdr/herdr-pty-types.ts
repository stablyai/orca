import { Buffer } from 'node:buffer'
import type { Project } from '../../../../shared/project-types'
import type { IPtyProvider, PtyProcessInfo } from '../../types'
import type { HerdrProjectHostGraph } from './ensure-herdr-workspace'
import {
  HerdrRuntimeError,
  type HerdrHostTransport,
  type HerdrTerminalController
} from './herdr-runtime-contract'

const HERDR_PTY_PREFIX = 'herdr:'

export function encodeHerdrPtyId(identity: HerdrPtyIdentity): string {
  return `${HERDR_PTY_PREFIX}${Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url')}`
}

export function decodeHerdrPtyId(id: string): HerdrPtyIdentity | null {
  if (!id.startsWith(HERDR_PTY_PREFIX)) {
    return null
  }
  try {
    const value = JSON.parse(
      Buffer.from(id.slice(HERDR_PTY_PREFIX.length), 'base64url').toString('utf8')
    ) as Partial<HerdrPtyIdentity> | null
    if (
      !value ||
      typeof value.projectId !== 'string' ||
      typeof value.hostId !== 'string' ||
      typeof value.worktreeId !== 'string' ||
      typeof value.tabId !== 'string' ||
      typeof value.leafId !== 'string'
    ) {
      return null
    }
    return value as HerdrPtyIdentity
  } catch {
    return null
  }
}

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
  /** True when another Herdr client already owns exclusive control. */
  sharedAttach?: boolean
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

export type { HerdrPaneMoveResult } from './herdr-runtime-contract-results'

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
