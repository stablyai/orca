import type { RpcContext } from '../core'
import { AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY } from '../../../../shared/protocol-version'
import { clientReadsCurrentRequests } from './structured-agent-session-current-requests'

/** Desktop snapshots require settled send echoes and independent current requests. */
export function clientSupportsSnapshotCatchUp(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientKind === 'mobile' ||
    (context.clientCapabilities?.includes(AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY) ===
      true &&
      clientReadsCurrentRequests(context))
  )
}
