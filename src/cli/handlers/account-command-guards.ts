import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/account-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'

export function rejectAccountRemoteSelectionFlags(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it on the host whose accounts you want to manage.`
  )
}

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
