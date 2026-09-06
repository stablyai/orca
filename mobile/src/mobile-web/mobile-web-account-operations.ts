import {
  MobileWebAccountConsumeResetPayloadSchema,
  MobileWebAccountConsumeResetResultSchema,
  MobileWebAccountResetCapabilityPayloadSchema,
  MobileWebAccountResetCapabilityResultSchema,
  MobileWebAccountSelectPayloadSchema,
  MobileWebAccountSelectResultSchema,
  MobileWebAccountSnapshotPayloadSchema
} from '../../../src/shared/mobile-web/account-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebAccountsSnapshot } from './mobile-web-account-presentation'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'

export async function executeMobileWebAccountOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  nativeAuthority: MobileWebNativeCapabilityAuthority
}): Promise<unknown> {
  if (args.operation === 'snapshot') {
    MobileWebAccountSnapshotPayloadSchema.parse(args.payload)
    const response = await args.client.sendRequest('accounts.list')
    requireSuccess(response)
    return mobileWebAccountsSnapshot(response.result)
  }
  if (args.operation === 'select') {
    const payload = MobileWebAccountSelectPayloadSchema.parse(args.payload)
    const method =
      payload.provider === 'claude'
        ? 'accounts.selectClaude'
        : payload.codexTarget?.runtime === 'wsl'
          ? 'accounts.selectCodexForTarget'
          : 'accounts.selectCodex'
    const params =
      method === 'accounts.selectCodexForTarget'
        ? { accountId: payload.accountId, target: payload.codexTarget }
        : { accountId: payload.accountId }
    requireSuccess(await args.client.sendRequest(method, params))
    return MobileWebAccountSelectResultSchema.parse(null)
  }
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
      snapshot: mobileWebAccountsSnapshot(result.snapshot)
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function requireSuccess(response: {
  ok: boolean
  error?: { code?: unknown }
}): asserts response is {
  ok: true
  result: unknown
} {
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error ?? {})
  }
}
