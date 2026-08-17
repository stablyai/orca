import type { Project } from '../../../../shared/project-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { HerdrWorktreeDescriptor } from './herdr-worktree-descriptor'

export type HerdrProjectHostGraph = {
  project: Project
  worktrees: HerdrWorktreeDescriptor[]
  tabsByWorktreeId: Record<string, TerminalTab[]>
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
  persistedPaneIdsByLeafId?: Record<string, string>
}
