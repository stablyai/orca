import type { Implementation } from '../generated/acp-protocol.generated'
import type { AcpLaunchSpec } from './acp-launch-contract'

export const ORCA_ACP_CLIENT_INFO: Implementation = { name: 'orca', version: '1' }

/** The identity initialize sends to a spec's agent. */
export function acpClientInfo(spec: Pick<AcpLaunchSpec, 'clientInfo'>): Implementation {
  return spec.clientInfo ?? ORCA_ACP_CLIENT_INFO
}
