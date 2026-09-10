import type { RuntimeWorktreeListResult, RuntimeWorktreePsResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatWorktreeList, formatWorktreePs, printResult } from '../format'
import {
  annotateOmittedHostScope,
  type WithAnnotatedHostScope
} from '../omitted-host-scope-selectors'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { withPublicWorkspaceListResponse } from '../worktree-public-identity'

export const WORKTREE_LIST_HANDLERS: Record<string, CommandHandler> = {
  'worktree ps': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreePsResult>>(
      'worktree.ps',
      { limit: getOptionalPositiveIntegerFlag(flags, 'limit') }
    )
    await annotateOmittedHostScope(client, result.result)
    printResult(result, json, formatWorktreePs)
  },
  'worktree list': async ({ flags, client, json }) => {
    const result = await client.call<WithAnnotatedHostScope<RuntimeWorktreeListResult>>(
      'worktree.list',
      {
        repo: getOptionalStringFlag(flags, 'repo'),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }
    )
    await annotateOmittedHostScope(client, result.result)
    printResult(withPublicWorkspaceListResponse(result), json, formatWorktreeList)
  }
}
