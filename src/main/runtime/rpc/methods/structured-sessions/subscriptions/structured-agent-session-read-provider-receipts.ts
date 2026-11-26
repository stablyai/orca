import {
  PROVIDER_RECEIPT_READ_METHOD,
  ReceiptRead
} from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod } from '../../../core'

export const LOCAL_READ_PROVIDER_RECEIPTS = defineMethod({
  name: PROVIDER_RECEIPT_READ_METHOD,
  permission: 'workspace',
  params: ReceiptRead,
  handler: (input, ctx) => {
    if (!ctx.localProviderReceipts) {
      throw new Error('forbidden')
    }
    return ctx.localProviderReceipts.readers.read(
      ctx.localProviderReceipts.endpoint,
      input,
      getStructuredAgentSessionHost()?.providerReceipts
    )
  }
})
