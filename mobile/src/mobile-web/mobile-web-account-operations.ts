import {
  MobileWebAccountConsumeResetPayloadSchema,
  MobileWebAccountConsumeResetResultSchema,
  MobileWebAccountResetCapabilityPayloadSchema,
  MobileWebAccountResetCapabilityResultSchema,
  MobileWebAccountsSnapshotSchema
} from '../../../src/shared/mobile-web/account-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'

/** Only the reset-credit arms are left: they mint a native idempotency key and carry the shell's
 * host identity, so they cannot be a plain desktop forward. */
export async function executeMobileWebAccountOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  nativeAuthority: MobileWebNativeCapabilityAuthority
}): Promise<unknown> {
  if (args.operation === 'resetCreditCapability') {
    MobileWebAccountResetCapabilityPayloadSchema.parse(args.payload)
    const capability = args.nativeAuthority.codexResetCreditCapability
    return MobileWebAccountResetCapabilityResultSchema.parse(
      capability ? await capability(args.client) : false
    )
  }
  if (args.operation === 'consumeResetCredit') {
    const payload = MobileWebAccountConsumeResetPayloadSchema.parse(args.payload)
    const consume = args.nativeAuthority.codexResetCreditConsume
    if (!consume) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    const result = await consume(args.client, payload.expectedScope)
    return MobileWebAccountConsumeResetResultSchema.parse({
      ...result,
      snapshot: MobileWebAccountsSnapshotSchema.parse(result.snapshot)
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
