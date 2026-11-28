import { STATUS_METHODS } from './host-management/status'
import { DESKTOP_WINDOW_METHODS } from './host-management/desktop-window'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs/sidebar-inputs'
import { SIDEBAR_REPO_ICON_METHODS } from './sidebar-inputs/sidebar-repo-icons'
import { REPO_METHODS } from './projects/repo'
import { WORKTREE_METHODS } from './workspaces/worktree'
import { TERMINAL_METHODS } from './terminal/terminal'
import { SESSION_TAB_METHODS } from './session-tabs/session-tabs'
import { CLIENT_EVENT_METHODS } from './client-events/client-events'
import { HOST_CAPABILITY_METHODS } from './host-management/host-capabilities'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './client-events/runtime-client-capabilities'
import { AGENT_HOOK_METHODS } from './agent-hooks/agent-hooks'
import {
  LAYOUT_APPLY_METHODS,
  LAYOUT_VIEW_REPORT_METHODS,
  WORKSPACE_LAYOUT_METHODS
} from './workspace-layout/workspace-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import { DEFAULT_LAZY_RPC_METHOD_GROUPS } from './lazy-rpc-method-groups'

export { DEFAULT_LAZY_RPC_METHOD_GROUPS }

export const EAGER_CORE_RPC_METHODS = [
  ...STATUS_METHODS,
  ...DESKTOP_WINDOW_METHODS,
  ...AGENT_HOOK_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS
] as const

export const EAGER_SERVICE_RPC_METHODS = [
  ...TERMINAL_METHODS,
  ...SESSION_TAB_METHODS,
  ...WORKSPACE_LAYOUT_METHODS,
  // Switch point: a window-owned build registers no layout command.
  ...(ORCA_LAYOUT_OWNER_IS_MAIN ? [...LAYOUT_APPLY_METHODS, ...LAYOUT_VIEW_REPORT_METHODS] : []),
  ...HOST_CAPABILITY_METHODS,
  ...RUNTIME_CLIENT_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  // Switch point: a window-fed build publishes no sidebar input.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN ? SIDEBAR_INPUT_METHODS : []),
  ...SIDEBAR_REPO_ICON_METHODS
] as const

export const EAGER_RPC_METHODS = [...EAGER_CORE_RPC_METHODS, ...EAGER_SERVICE_RPC_METHODS] as const

export const DEFAULT_RPC_DISPATCH_CONFIG = {
  methods: EAGER_RPC_METHODS,
  lazyGroups: DEFAULT_LAZY_RPC_METHOD_GROUPS
} as const
