import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { z } from 'zod'

export const rexCreatedSession = lazyZodSchema(() =>
  z.object({
    session_id: z.string().startsWith('session:'),
    initial_windows: z
      .array(z.object({ block_ids: z.array(z.string().startsWith('block:')) }))
      .min(1)
  })
)
export const rexListedSessions = lazyZodSchema(() =>
  z.object({ sessions: z.array(z.object({ session_id: z.string() })).nullable() })
)
export const rexListedBlocks = lazyZodSchema(() =>
  z.object({ blocks: z.array(z.object({ block_id: z.string().nullable() })).nullable() })
)

export const rexAttachedSession = lazyZodSchema(() =>
  z.object({ client_id: z.string().startsWith('client:') })
)
export const rexOwnedBlocks = lazyZodSchema(() =>
  z.object({
    blocks: z
      .array(z.object({ block_id: z.string().nullable(), owner: z.string().nullable().optional() }))
      .nullable()
  })
)
export const rexDataTicket = lazyZodSchema(() => z.object({ ticket: z.string() }))
export const rexTerminalSize = lazyZodSchema(() =>
  z.object({
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    owner: z.string().nullable().optional()
  })
)
export const rexTerminalProcess = lazyZodSchema(() =>
  z.object({
    child: z
      .object({ cwd: z.string().optional(), pid: z.number().int().positive().optional() })
      .nullable()
      .optional(),
    foreground: z
      .object({
        cwd: z.string().optional(),
        name: z.string().optional(),
        pid: z.number().int().positive().optional()
      })
      .nullable()
      .optional(),
    last_exit: z.object({ exit_code: z.number().int() }).nullable().optional()
  })
)
export const rexWriteResult = lazyZodSchema(() =>
  z.object({ bytes_written: z.number().int().nonnegative() })
)

export const rexTerminalModes = lazyZodSchema(() =>
  z.object({
    screen: z.string(),
    modes: z
      .array(z.object({ number: z.number().int(), ansi: z.boolean().optional(), set: z.boolean() }))
      .max(256)
      .nullable()
  })
)
