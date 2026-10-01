import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayResetPreparationBinding } from '../shared/relay-reset-preparation-contract'
import type { RelayGraceLifecycle } from './relay-grace-lifecycle'
import type { RelaySocketOwnership } from './relay-socket-ownership'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayOwnerReset } from './relay-owner-reset'
import {
  RELAY_OWNER_RESET_CAPABILITY,
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from '../shared/relay-owner-reset-contract'

export function registerRelayOwnerReset(
  dispatcher: Pick<RelayDispatcher, 'onRequest'>,
  options: {
    runtimeIncarnation?: string
    owners: Pick<
      SshPtyConsumerSessionAdapter,
      'activeSessionOwner' | 'assertOwnerPublicationSettled'
    >
    lifecycle: Pick<RelayGraceLifecycle, 'prepareShutdown' | 'finishShutdown'>
    persistPrepared?: ConstructorParameters<typeof RelayOwnerReset>[0]['persistPrepared']
    describePreparation?: (
      principal: string,
      authenticationKind: string
    ) => RelayResetPreparationBinding
    socket: Pick<RelaySocketOwnership, 'ownsCurrentPath' | 'server'>
  }
): (context?: RequestContext) => {
  capabilities: string[]
  ownerReset?: {
    version: 1
    runtimeIncarnation: string
    preparation?: RelayResetPreparationBinding
  }
} {
  const ownsEndpoint = () =>
    options.socket.server?.listening === true && options.socket.ownsCurrentPath()
  const reset = new RelayOwnerReset({ ...options, ownsEndpoint })
  dispatcher.onRequest(RELAY_OWNER_RESET_METHOD, (params, context) =>
    reset.prepare(params, context)
  )
  dispatcher.onRequest(RELAY_PREPARED_RESET_RECOVERY_METHOD, async (params, context) =>
    reset.recoverPrepared(params, context)
  )
  return (context) => {
    if (!ownsEndpoint()) {
      return { capabilities: [] }
    }
    const identity = context?.sessionIdentity
    const preparation =
      options.persistPrepared &&
      identity?.authenticated &&
      identity.allowSessionOwner &&
      ['launch-nonce', 'endpoint-credential'].includes(identity.authenticationKind) &&
      !context!.isStale() &&
      !context!.signal?.aborted
        ? options.describePreparation?.(identity.principal, identity.authenticationKind)
        : undefined
    return ownsEndpoint()
      ? {
          capabilities: [
            RELAY_OWNER_RESET_CAPABILITY,
            ...(options.persistPrepared ? [RELAY_DURABLE_RESET_PREPARATION_CAPABILITY] : [])
          ],
          ownerReset: {
            version: 1,
            runtimeIncarnation: reset.runtimeIncarnation,
            ...(preparation ? { preparation } : {})
          }
        }
      : { capabilities: [] }
  }
}
