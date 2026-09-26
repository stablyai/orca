import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

/**
 * `--account <id|email>`: the managed Claude account a launch runs on, resolved by the host.
 *
 * Why the capability check: an older host strips the unknown field and would quietly start the
 * agent on its active account — exactly what the caller asked not to happen.
 */
export async function readClaudeLaunchAccountFlag(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  agent: string | undefined
): Promise<string | undefined> {
  if (!flags.has('account')) {
    return undefined
  }
  const account = getOptionalStringFlag(flags, 'account')?.trim()
  if (!account) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--account requires a Claude account id or email.'
    )
  }
  if (agent !== 'claude') {
    throw new RuntimeClientError('invalid_argument', '--account requires --agent claude.')
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected Orca runtime does not support --account for Claude launches. Update or restart Orca and try again.'
    )
  }
  return account
}
