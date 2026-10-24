import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRequiredWorktreeSelector } from '../selectors'

export const WORKTREE_SLEEP_WAKE_HANDLERS: Record<string, CommandHandler> = {
  'worktree sleep': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{
      worktreeId: string
      chatFailed?: boolean
      vmSuspendFailure?: string
    }>('worktree.sleep', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    })
    // Why: the sleep has finished when this returns; a terminal stop it could not prove fails the call.
    printResult(result, json, (value) =>
      [
        `slept: ${value.worktreeId}`,
        ...(value.chatFailed ? ['warning: a host could not confirm its chats stopped'] : []),
        ...(value.vmSuspendFailure ? [`warning: VM still running: ${value.vmSuspendFailure}`] : [])
      ].join('\n')
    )
  },
  'worktree wake': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktreeId: string; sleepingAgentWake: string }>(
      'worktree.wake',
      { worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client) }
    )
    printResult(result, json, (value) => `sleepingAgentWake: ${value.sleepingAgentWake}`)
  }
}
