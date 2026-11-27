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
    const { endpoint, readers } = ctx.localProviderReceipts
    // The unary dispatch can yield after port admission.
    if (!readers.canStartRead(endpoint, input.reader)) {
      throw new Error('provider_receipt_sender_retired')
    }
    return readers.read(
      endpoint,
      input,
      getStructuredAgentSessionHost()?.providerReceipts,
      undefined,
      ctx.signal
    )
  }
})
