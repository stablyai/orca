import { z } from 'zod'
import {
  OptionalString,
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
    body: OptionalString,
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
    // A paired server: this Orca carries the mail there and the replies back (`send --on`).
    on: OptionalString,
    waitForLifecycleSettlement: OptionalBoolean,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (!isDispatchMutationMessageType(params.type) || !params.to || !isGroupAddress(params.to)) {
      return
    }
    // Lifecycle authority targets one coordinator; fanout would leak signals to unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })
