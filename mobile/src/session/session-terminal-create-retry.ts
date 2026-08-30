import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { SESSION_TABS_CREATE_TERMINAL_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

export function supportsSessionTerminalCreateCutoverRetry(
  capabilities: readonly string[] | undefined
): boolean {
  return (
    capabilities?.includes(SESSION_TABS_CREATE_TERMINAL_IDEMPOTENCY_RUNTIME_CAPABILITY) === true
  )
}

// Why: a create in flight when the mobile transport migrates (relay→direct
// hand-off on cellular) rejects client-side with a cutover error even though the
// host may still complete it — the desktop never logs a trace, the user just
// sees "Couldn't run <quick command>". A capability-gated replay of the same
// mutation joins the host-owned create. Mirrors sendWorktreeCreateResilient in
// tasks/worktree-create-retry.ts.
const SESSION_TERMINAL_CREATE_CUTOVER_MAX_RETRIES = 5

export async function sendSessionTerminalCreateResilient(
  client: RpcClient,
  params: Record<string, unknown> & { clientMutationId: string },
  opts: { supportsIdempotentCutoverRetry: boolean }
): Promise<RpcResponse> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      return await client.sendRequest('session.tabs.createTerminal', params)
    } catch (error) {
      if (
        !opts.supportsIdempotentCutoverRetry ||
        !isLogicalClientCutoverError(error) ||
        migrationRetry >= SESSION_TERMINAL_CREATE_CUTOVER_MAX_RETRIES
      ) {
        throw error
      }
      // Why: LogicalClientCutoverError is raised only after migrateTo installs an
      // authenticated replacement session, so retry immediately instead of backing off.
    }
  }
}
