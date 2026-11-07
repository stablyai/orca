import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRequiredWorktreeSelector } from '../selectors'

export const WORKTREE_ACTIVATE_HANDLERS: Record<string, CommandHandler> = {
  // Opening a workspace is the request that wakes a sleeping recipe VM behind it (#36923).
  'worktree activate': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktreeId: string }>('worktree.activate', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      // A paired caller's default is its own view; the CLI opens the workspace on its host.
      navigation: 'host'
    })
    printResult(result, json, ({ worktreeId }) => `Activated ${worktreeId}`)
  }
}
