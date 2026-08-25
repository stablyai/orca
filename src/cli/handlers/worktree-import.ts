import type {
  RuntimeWorktreeImportResult,
  RuntimeWorktreeUnimportResult
} from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { formatWorktreeImport, formatWorktreeUnimport, printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'

// Why: an Orca server that predates worktree import answers `method_not_found`, which reads as an
// Orca bug rather than a version gap — and `--host runtime:<id>` can reach an older host without
// the caller meaning to. Name the version gap the way the project host setup commands already do.
async function callWorktreeImportMethod<TResult>(
  client: HandlerContext['client'],
  method: string,
  worktree: string
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>(method, { worktree })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support worktree import yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
}

export const WORKTREE_IMPORT_HANDLERS: Record<string, CommandHandler> = {
  'worktree import': async ({ flags, client, cwd, json }) => {
    const result = await callWorktreeImportMethod<RuntimeWorktreeImportResult>(
      client,
      'worktree.import',
      await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    )
    printResult(result, json, formatWorktreeImport)
  },
  'worktree unimport': async ({ flags, client, cwd, json }) => {
    const result = await callWorktreeImportMethod<RuntimeWorktreeUnimportResult>(
      client,
      'worktree.unimport',
      await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    )
    printResult(result, json, formatWorktreeUnimport)
  }
}
