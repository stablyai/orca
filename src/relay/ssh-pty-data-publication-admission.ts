import type { PtyConsumerSessionGrant } from '../shared/pty-consumer-session'
import type { SshPtySourceCreditAdapter } from './ssh-pty-source-credit-adapter'

export type SshPtyDeliveryMode = 'unadmitted' | 'source-owner' | 'legacy-owner' | 'subscriber'

export function sshPtyDeliveryMode(
  grant: Readonly<PtyConsumerSessionGrant> | null
): SshPtyDeliveryMode {
  if (!grant) {
    return 'unadmitted'
  }
  if (grant.role !== 'session-owner') {
    return 'subscriber'
  }
  return grant.capabilities?.outputFlowControl ? 'source-owner' : 'legacy-owner'
}

export function admitsSshPtyDataPublication(
  grant: Readonly<PtyConsumerSessionGrant> | null,
  params: Readonly<Record<string, unknown>>,
  sourceCredit: Pick<SshPtySourceCreditAdapter, 'ownsDelivery'>
): boolean {
  if (!grant) {
    return false
  }
  if (grant.role !== 'session-owner' || !grant.capabilities?.outputFlowControl) {
    return true
  }
  const id = typeof params.id === 'string' ? params.id : ''
  const token = typeof params.deliveryToken === 'string' ? params.deliveryToken : ''
  const identity = token ? sourceCredit.ownsDelivery(token, grant, id) : null
  return (
    identity !== null &&
    params.clientGeneration === identity.clientGeneration &&
    params.ownerGeneration === identity.ownerGeneration &&
    params.ptyIncarnation === identity.ptyIncarnation
  )
}
