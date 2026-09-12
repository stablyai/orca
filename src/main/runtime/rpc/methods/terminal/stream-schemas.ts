import { z } from 'zod'
import { requiredString } from '../../schemas'
import { TerminalViewport } from './unary-schemas'
import { TerminalHandle } from '../../../../../shared/rpc-contract/terminal-stream-params'
export {
  TerminalMultiplex,
  TerminalResizeForClient,
  TerminalSubscribe
} from '../../../../../shared/rpc-contract/terminal-stream-params'

export const TerminalMultiplexSubscribeFrame = TerminalHandle.extend({
  streamId: z.number().int().min(1),
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      ackOutput: z.literal(1).optional(),
      ackOutputSourceRanges: z.literal(1).optional(),
      desktopViewportClaims: z.literal(1).optional(),
      outputPause: z.literal(1).optional(),
      terminalExited: z.literal(1).optional(),
      writeUnavailable: z.literal(1).optional()
    })
    .optional()
})

export const TerminalMultiplexLegacyAckFrame = z
  .object({
    bytes: z.number().int().nonnegative()
  })
  .strict()

export const TerminalMultiplexSourceRangeAckFrame = z
  .object({
    streamGeneration: z.string().min(1),
    ackedEndByte: z.number().int().nonnegative()
  })
  .strict()

export const TerminalMultiplexSnapshotRequestFrame = z.object({
  requestId: z.number().int().positive().optional(),
  scrollbackRows: z.number().finite().optional()
})
