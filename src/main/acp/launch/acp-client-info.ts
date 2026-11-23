import type { Implementation } from '../generated/acp-protocol.generated'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'

export const ORCA_ACP_CLIENT_INFO: Implementation = { name: 'orca', version: '1' }

/** Orca under its own name, with this app's version where the process knows it. */
export function orcaAcpClientInfo(): Implementation {
  const version = hasAppEnvironment() ? getAppEnvironment().getVersion() : ''
  return version ? { name: 'orca', version } : ORCA_ACP_CLIENT_INFO
}

/** The identity initialize sends to a spec's agent at the launched version. */
export function acpClientInfo(
  spec: Pick<AcpLaunchSpec, 'clientInfo'>,
  version: string | null,
  fallback: Implementation = ORCA_ACP_CLIENT_INFO
): Implementation {
  return spec.clientInfo?.(version) ?? fallback
}
