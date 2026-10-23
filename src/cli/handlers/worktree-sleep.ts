import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'

export const worktreeSleepHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  const callerWorktreeId = process.env.ORCA_WORKTREE_ID
  if (flags.get('force') !== true && !client.isRemote && callerWorktreeId) {
    const target = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree
    })
    if (target.result.worktree.id === callerWorktreeId) {
      throw new RuntimeClientError(
        'invalid_argument',
        'This terminal belongs to the worktree you asked to sleep, so sleeping it would stop this terminal too. Run the command from another worktree, or pass --force.'
      )
    }
  }
  try {
    const result = await client.call<{ worktreeId: string }>('worktree.sleep', { worktree })
    printResult(result, json, (value) => `sleep requested: ${value.worktreeId}`)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not support sleeping a worktree from the CLI yet. Update Orca on the host and try again.'
      )
    }
    throw error
  }
}
