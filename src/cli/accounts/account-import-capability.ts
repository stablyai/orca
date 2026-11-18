import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/account-runtime-capabilities'

export async function assertAccountImportSupported(
  { client }: HandlerContext,
  agent: 'claude' | 'codex'
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  const capability =
    agent === 'claude' ? CLAUDE_SIGN_IN_RUNTIME_CAPABILITY : ACCOUNT_IMPORT_RUNTIME_CAPABILITY
  if (!status.result.capabilities?.includes(capability)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old to add accounts from the CLI. Update or restart Orca and try again.'
    )
  }
}
