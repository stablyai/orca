import type { Project } from '../../shared/types'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import type { HerdrProjectHostGraph } from './herdr-runtime-manager'
import { HerdrRuntimeError, type HerdrTerminalController } from './herdr-runtime-contract'

export type HerdrPtyIdentity = {
  hostId: string
  projectId: string
  worktreeId: string
  tabId: string
  leafId: string
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
  controller: HerdrTerminalController
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
  fallback: IPtyProvider,
  target: HerdrPtyTarget
): Promise<void> {
  if (!target.activateHerdr || !target.legacyMigrationWorktreeIds) {
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
