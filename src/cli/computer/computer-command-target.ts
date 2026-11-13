import type { ComputerAppQuery } from '../../shared/computer-use-runtime-types'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { getBrowserWorktreeSelector } from '../workspace-selection/workspace-selector'

export type ComputerCliTarget = {
  session?: string
  worktree?: string
  app: ComputerAppQuery
}

export async function getComputerCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<ComputerCliTarget> {
  const app = getRequiredStringFlag(flags, 'app')
  const session = getOptionalStringFlag(flags, 'session')
  const worktree = getOptionalStringFlag(flags, 'worktree')
  if (session && worktree) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Computer-use targeting accepts either --session or --worktree, not both'
    )
  }
  if (session) {
    return { session, app }
  }
  return {
    app,
    worktree: await getBrowserWorktreeSelector(flags, cwd, client)
  }
}
