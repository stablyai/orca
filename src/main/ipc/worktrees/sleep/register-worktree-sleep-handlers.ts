import { registerAppHandler } from '../../app-registry/app-handler-registry'

import type { WorkspaceSleepRequest } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import type { RestoredPane } from '../../../runtime/terminal/recovery/restored-pane-start'

function isRestoredPane(value: unknown): value is RestoredPane {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'tabId' in value &&
    typeof value.tabId === 'string' &&
    'leafId' in value &&
    typeof value.leafId === 'string'
  )
}

export function registerWorktreeSleepHandlers(context: WorktreeIpcContext): void {
  registerAppHandler('worktrees:sleep', (_event, request: WorkspaceSleepRequest) =>
    context.runtime.sleepWorkspaces({
      targets: request.targets,
      markChatsAsleep: request.markChatsAsleep
    })
  )
  // Reopening during sleep must preserve the running VM.
  registerAppHandler('worktrees:sleepReopened', (_event, worktreeId: string) =>
    context.runtime.noteWorkspaceReopened(worktreeId)
  )
  // Main resumes the session before the renderer attaches its spawn.
  registerAppHandler('worktrees:resumeSleptPane', (_event, pane: unknown, automatic: unknown) => {
    if (!isRestoredPane(pane)) {
      throw new Error('invalid_pane')
    }
    if (automatic !== undefined && typeof automatic !== 'boolean') {
      throw new Error('invalid_automatic')
    }
    return context.runtime.resumeSleptPane(pane, automatic)
  })
  registerAppHandler(
    'worktrees:retireStrandedSleepRecord',
    (_event, args: { worktreeId?: unknown; paneKey?: unknown } | undefined) => {
      if (typeof args?.worktreeId !== 'string' || typeof args.paneKey !== 'string') {
        throw new Error('invalid_sleep_record')
      }
      return context.runtime.retireStrandedSleepRecord(args.worktreeId, args.paneKey)
    }
  )
}
