import {
  MobileWebSpeechCancelPayloadSchema,
  MobileWebSpeechConfigurePayloadSchema,
  MobileWebSpeechModelActionPayloadSchema,
  MobileWebSpeechStartPayloadSchema,
  MobileWebSpeechStopPayloadSchema
} from '../../../src/shared/mobile-web/speech-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import {
  configureMobileWebSpeech,
  deleteMobileWebSpeechModel,
  downloadMobileWebSpeechModel,
  loadMobileWebSpeechSetup
} from './mobile-web-speech-setup-operations'

export async function executeMobileWebSpeechOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebSpeechAuthority
}): Promise<unknown> {
  if (args.operation === 'setup') {
    return loadMobileWebSpeechSetup(args.client, args.payload)
  }
  if (args.operation === 'downloadModel') {
    MobileWebSpeechModelActionPayloadSchema.parse(args.payload)
    return downloadMobileWebSpeechModel(args.client, args.payload)
  }
  if (args.operation === 'deleteModel') {
    MobileWebSpeechModelActionPayloadSchema.parse(args.payload)
    return deleteMobileWebSpeechModel(args.client, args.payload)
  }
  if (args.operation === 'configure') {
    MobileWebSpeechConfigurePayloadSchema.parse(args.payload)
    return configureMobileWebSpeech(args.client, args.payload)
  }
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
