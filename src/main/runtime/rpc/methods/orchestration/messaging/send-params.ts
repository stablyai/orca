import { z } from 'zod'
import {
  OptionalString,
  OptionalBoolean
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
    subject: OptionalString.default(''),
    deliveryOutcome: OptionalBoolean,
    resume: OptionalBoolean,
    expectedFailureId: OptionalString,
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
    if (!params.subject.trim() && (!params.resume || params.body)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing --subject', path: ['subject'] })
    }
    if (params.resume && !params.expectedFailureId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Missing --failure-id from the held message receipt.',
        path: ['expectedFailureId']
      })
    }
    if (params.expectedFailureId && !params.resume) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '--failure-id requires --resume.',
        path: ['resume']
      })
    }
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
