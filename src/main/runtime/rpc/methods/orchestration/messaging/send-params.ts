import { z } from 'zod'
import {
  OptionalString,
  OptionalPlainString,
  OptionalBoolean,
  requiredString
} from '../../../../../../shared/rpc-contract/rpc-param-primitives'
import { isGroupAddress } from '../../../../orchestration/addressing/groups/group-addressing'
import { MESSAGE_TYPES } from '../../../../orchestration/db/orchestration-records'
import {
  getLifecycleGroupRecipientError,
  isDispatchMutationMessageType
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'

const SEND_MESSAGE_TYPE_ERROR = [
  `Invalid --type. Expected one of: ${MESSAGE_TYPES.join(', ')}.`,
  'To answer a worker question, use the same Orca CLI executable with orchestration reply --id <msg_id> --body <text>.'
].join(' ')

export const SendParams = z
  .object({
    to: OptionalString,
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    // Keep '' until the worker_done check runs; it is normalized to undefined below.
    body: OptionalPlainString,
    type: z
      .enum(MESSAGE_TYPES, {
        error: SEND_MESSAGE_TYPE_ERROR
      })
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Use remint-stable pane keys to attest worker_done/heartbeat; from handles only route.
    senderPaneKey: OptionalString,
    run: OptionalString,
    /** With `to: bot:<name>`, the one of that bot's chats the mail lands in instead of its Home Chat;
     *  `new` starts a new chat for it. */
    chat: OptionalString,
    /** With `to: bot:<name>`, an item number: the mail lands in the chat that owns it. */
    item: OptionalString,
    /** With `item`: files on this computer, sent with the mail into the item's chat. */
    files: z.array(z.string().min(1).max(4096)).max(30).optional(),
    // A paired server: this Orca carries the mail there and the replies back (`send --on`).
    on: OptionalString,
    waitForLifecycleSettlement: OptionalBoolean,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (isDispatchMutationMessageType(params.type) && params.to && isGroupAddress(params.to)) {
      // Lifecycle authority targets one coordinator; fanout would leak signals to unrelated terminals.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: getLifecycleGroupRecipientError(params.type),
        path: ['to']
      })
    }
    if (params.type === 'worker_done' && params.body !== undefined && params.body.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'worker_done body must be nonempty when provided.',
        path: ['body']
      })
    }
  })
  .transform((params) => (params.body === '' ? { ...params, body: undefined } : params))
