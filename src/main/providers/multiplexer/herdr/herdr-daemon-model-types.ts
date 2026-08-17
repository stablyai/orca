import type { HerdrPaneLayoutRect } from './herdr-socket-types'
import type { HerdrAgentStatus } from './herdr-runtime-contract'

export const DEFAULT_AREA: HerdrPaneLayoutRect = { x: 0, y: 0, width: 120, height: 30 }
export const DEFAULT_RATIO = 0.5

export type { HerdrAgentStatus }

export type ModelPane = {
  pane_id: string
  tab_id: string
  workspace_id: string
  cwd: string
  label?: string
  tokens?: Record<string, string>
  revision: number
  agent: string | null
  agent_status: HerdrAgentStatus
  connection_id?: string | null
}

export type ModelTab = {
  tab_id: string
  workspace_id: string
  label: string
  root: LayoutTree
  focused_pane_id: string | null
  zoomed: boolean
}

export type ModelWorkspace = {
  workspace_id: string
  label: string
  tokens?: Record<string, string>
  metadata_source?: string | null
  worktree?: {
    checkout_path: string
    repo_key?: string
    repo_name?: string
    repo_root?: string
    is_linked_worktree?: boolean
  }
}

export type LayoutTree = PaneNode | SplitNode

export type PaneNode = {
  kind: 'pane'
  pane_id: string
}

export type SplitNode = {
  kind: 'split'
  direction: 'right' | 'down'
  ratio: number
  first: LayoutTree
  second: LayoutTree
}

export type CreatePaneOptions = {
  cwd: string
  label?: string
  agent?: string | null
}
