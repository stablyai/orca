import type { AgentJournalTypedBy } from '../../../../shared/agent-session/journal/agent-journal-typed-by'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { ConnectorCloud } from '../../../connector-cloud/connector-cloud'
import type { DeviceSelfRpcContext, RpcContext } from '../core'
import { isAgentRpcCaller, type RpcCallerIdentity } from './rpc-caller-identity'

/** Where a message was typed, from the transport alone; unknown callers stamp nothing. A paired
 *  device keeps the account it claims as of now (a desktop's from its own connection; a phone's from
 *  the desktop behind it), so a later sign-in never renames a message already sent. `own` is decided
 *  here, against the host's account at send, and only when both sides have one. */
export function typedByOf(context: {
  caller?: RpcCallerIdentity | undefined
  clientKind?: RpcContext['clientKind']
  deviceSelf?: Pick<DeviceSelfRpcContext, 'orcaAccount'> | undefined
  runtime: Partial<Pick<OrcaRuntimeService, 'pairedDeviceAccount'>> & {
    getConnectorCloud?: () => Pick<ConnectorCloud, 'signedInAccount'> | null
  }
}): AgentJournalTypedBy | undefined {
  const { caller } = context
  if (isAgentRpcCaller(caller)) {
    return { by: 'agent' }
  }
  if (caller?.kind === 'desktop') {
    return { by: 'host' }
  }
  if (caller?.kind !== 'paired-device') {
    return undefined
  }
  const connectionClaim =
    context.clientKind === 'mobile' ? undefined : (context.deviceSelf?.orcaAccount() ?? null)
  const claim = context.runtime.pairedDeviceAccount?.(caller.deviceId, connectionClaim)
  if (!claim) {
    return { by: 'device', deviceId: caller.deviceId }
  }
  // Null when signed out, and in `orca serve`: nothing to compare with, so no message is another's.
  const hostAccountId = context.runtime.getConnectorCloud?.()?.signedInAccount() ?? null
  return {
    by: 'device',
    deviceId: caller.deviceId,
    ...(claim.name ? { account: claim.name } : {}),
    accountId: claim.id,
    ...(hostAccountId ? { own: claim.id === hostAccountId } : {}),
    ...(claim.computer ? { computer: claim.computer } : {}),
    ...(claim.phone ? { phone: claim.phone } : {})
  }
}
