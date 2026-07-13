import type { RuntimeNotificationDispatch } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getOptionalWorktreeSelector } from '../selectors'

function formatNotifyDispatch({ dispatch }: { dispatch: RuntimeNotificationDispatch }): string {
  if (!dispatch.delivered) {
    return `Notification not delivered${dispatch.reason ? ` (${dispatch.reason})` : ''}.`
  }
  const target = dispatch.paneKey
    ? ` → pane ${dispatch.paneKey}`
    : dispatch.worktreeId
      ? ` → ${dispatch.worktreeId}`
      : ''
  return `Notification delivered${target}.`
}

/**
 * CLI handlers for agent-triggered Orca notifications.
 *
 * This gives scripts a first-party notification trigger instead of requiring
 * third-party push services just to surface an agent status summary.
 */
export const NOTIFY_HANDLERS: Record<string, CommandHandler> = {
  // Why: gives an agent/orchestrator a native way to fire an Orca notification
  // on demand (an AI summary), deep-linking the tap to the pane it names —
  // the trigger that previously forced shelling out to a third-party push.
  notify: async ({ flags, client, cwd, json }) => {
    // `--pane` takes a terminal handle; `--terminal` is a compatibility alias.
    const terminal =
      getOptionalStringFlag(flags, 'pane') ?? getOptionalStringFlag(flags, 'terminal')
    const worktree = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const title = getOptionalStringFlag(flags, 'title')
    const result = await client.call<{ dispatch: RuntimeNotificationDispatch }>(
      'notifications.dispatch',
      {
        message: getRequiredStringFlag(flags, 'message'),
        ...(title ? { title } : {}),
        ...(terminal ? { terminal } : {}),
        ...(worktree ? { worktree } : {})
      }
    )
    printResult(result, json, formatNotifyDispatch)
    if (!result.result.dispatch.delivered) {
      // Why: parity with `terminal wait` — a non-delivered notification is a
      // soft failure scripts can detect via exit code.
      process.exitCode = 1
    }
  }
}
