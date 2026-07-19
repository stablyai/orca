import type { Project, TerminalLayoutSnapshot, TerminalTab } from '../../shared/types'
import type { HerdrWorktreeDescriptor } from './herdr-worktree-descriptor'

export type HerdrProjectHostGraph = {
  project: Project
  worktrees: HerdrWorktreeDescriptor[]
  tabsByWorktreeId: Record<string, TerminalTab[]>
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
}
