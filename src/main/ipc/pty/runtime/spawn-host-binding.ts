import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/workspace-layout/terminal-tab-id'
import type { RuntimePtySpawnArgs, RuntimePtySpawnState } from './spawn-state'

/**
 * The pane a spawn persists its binding into, or undefined when the caller did not ask for one.
 * Pure input validation, so a replacing spawn can run it before it stops the old process.
 */
export function resolveRuntimeHostSessionBinding(
  deps: Pick<RuntimePtySpawnState['deps'], 'store'>,
  args: Pick<
    RuntimePtySpawnArgs,
    | 'persistHostSessionBinding'
    | 'worktreeId'
    | 'tabId'
    | 'leafId'
    | 'expectedSourceBinding'
    | 'placement'
  >
): RuntimePtySpawnState['hostSessionBinding'] {
  if (args.persistHostSessionBinding !== true) {
    return undefined
  }
  if (
    !deps.store ||
    typeof args.worktreeId !== 'string' ||
    typeof args.tabId !== 'string' ||
    !isValidTerminalTabId(args.tabId) ||
    args.tabId.length > 512 ||
    typeof args.leafId !== 'string' ||
    !isTerminalLeafId(args.leafId)
  ) {
    throw new Error('Cannot persist runtime PTY binding without worktreeId, tabId, and leafId')
  }
  return {
    store: deps.store,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    ...(args.expectedSourceBinding ? { expectedSourceBinding: args.expectedSourceBinding } : {}),
    ...(args.placement ? { placement: args.placement } : {})
  }
}
