import * as z from 'zod'
import { PROVIDER_RECEIPT_READ_METHOD } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod } from '../../../core'

export const ReceiptReader = z
  .object({ id: z.uuid(), generation: z.number().int().nonnegative() })
  .strict()
export const ReceiptCursor = z
  .object({ sequence: z.number().int().positive(), nonce: z.uuid() })
  .strict()

export const LOCAL_READ_PROVIDER_RECEIPTS = defineMethod({
  name: PROVIDER_RECEIPT_READ_METHOD,
  permission: 'workspace',
  params: z
    .object({
      reader: ReceiptReader,
      hostIncarnation: z.uuid().nullable(),
      since: ReceiptCursor.nullable(),
      discarded: z.boolean().optional()
    })
    .strict(),
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
