import {
  assertCodexAccountLaunchRequest,
  CODEX_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/agent-launch-account'
import { LaunchAccountParam } from '../../shared/rpc-contract/launch-account-param'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

export async function getCodexLaunchAccountFlag(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  if (!flags.has('account')) {
    return undefined
  }
  const account = getRequiredStringFlag(flags, 'account')
  const parsed = LaunchAccountParam.safeParse(account)
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--account requires an account id, unique email, or system.'
    )
  }
  try {
    assertCodexAccountLaunchRequest({
      account: parsed.data,
      agent: getOptionalStringFlag(flags, 'agent'),
      terminal: getOptionalStringFlag(flags, 'terminal'),
      on: getOptionalStringFlag(flags, 'on')
    })
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : String(error)
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !Array.isArray(status.result?.capabilities) ||
    !status.result.capabilities.includes(CODEX_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected Orca runtime does not support explicit Codex accounts. No launch was requested.'
    )
  }
  return parsed.data
}
