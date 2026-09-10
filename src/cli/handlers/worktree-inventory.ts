import type { WorktreeInventoryResult } from '../../shared/worktree/inventory'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

export const worktreeInventoryHandler: CommandHandler = async ({ flags, client, json }) => {
  if (
    client.isRemote ||
    flags.has('environment') ||
    flags.has('pairing-code') ||
    process.env.ORCA_ENVIRONMENT ||
    process.env.ORCA_PAIRING_CODE ||
    process.env.ORCA_REMOTE_PAIRING
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Inventory requires a local runtime connection; remote environment and pairing selection are unsupported.'
    )
  }
  if (getRequiredStringFlag(flags, 'host') !== 'local') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Inventory supports only --host local (native Git).'
    )
  }
  const result = await client.call<WorktreeInventoryResult>('worktree.inventory', {
    repo: getRequiredStringFlag(flags, 'repo'),
    repoPath: getRequiredStringFlag(flags, 'repo-path'),
    projectId: getRequiredStringFlag(flags, 'project'),
    hostId: getRequiredStringFlag(flags, 'host')
  })
  printResult(result, json, (value) => JSON.stringify(value, null, 2))
}
