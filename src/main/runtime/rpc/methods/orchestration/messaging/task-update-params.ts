import { z } from 'zod'
import {
  OptionalString,
  requiredString
} from '../../../../../../shared/rpc-contract/rpc-param-primitives'

const TASK_STATUSES: string[] = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']

export const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v)) {
        return v
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})
