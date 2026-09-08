import {
  MobileWebSpeechCancelPayloadSchema,
  MobileWebSpeechStartPayloadSchema,
  MobileWebSpeechStopPayloadSchema
} from '../../../src/shared/mobile-web/speech-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
export async function executeMobileWebSpeechOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebSpeechAuthority
}): Promise<unknown> {
  if (args.operation === 'start') {
    MobileWebSpeechStartPayloadSchema.parse(args.payload)
    return args.authority.start(args.client)
  }
  if (args.operation === 'stop') {
    MobileWebSpeechStopPayloadSchema.parse(args.payload)
    return args.authority.stop()
  }
  if (args.operation === 'cancel') {
    MobileWebSpeechCancelPayloadSchema.parse(args.payload)
    await args.authority.cancel()
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
