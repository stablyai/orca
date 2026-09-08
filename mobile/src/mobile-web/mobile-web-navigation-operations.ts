import {
  MobileWebNavigationReconnectPayloadSchema,
  MobileWebNavigationRemoveHostPayloadSchema,
  MobileWebNavigationRoutePayloadSchema
} from '../../../src/shared/mobile-web/navigation-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export type MobileWebNavigationAuthority = {
  route(destination: 'hostPicker' | 'pairingRepair'): void | Promise<void>
  reconnect(): void | Promise<void>
  removeHost(): void | Promise<void>
}

export async function executeMobileWebNavigationOperation(args: {
  operation: string
  payload: unknown
  authority: MobileWebNavigationAuthority | undefined
}): Promise<null> {
  if (args.operation === 'route') {
    const payload = MobileWebNavigationRoutePayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    await authority.route(payload.destination)
    return null
  }
  if (args.operation === 'reconnect') {
    MobileWebNavigationReconnectPayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    await authority.reconnect()
    return null
  }
  if (args.operation === 'removeHost') {
    MobileWebNavigationRemoveHostPayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    await authority.removeHost()
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function requireAuthority(
  authority: MobileWebNavigationAuthority | undefined
): MobileWebNavigationAuthority {
  if (!authority) {
    throw new MobileWebBrokerError('unavailable')
  }
  return authority
}
