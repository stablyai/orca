import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { z } from 'zod'

export const rexLaunchJob = lazyZodSchema(() =>
  z.object({
    id: z.number().int().positive(),
    profile: z.string().min(1),
    cwd: z.string().min(1),
    opts: z.object({
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
      sessionId: z.string().optional(),
      shellOverride: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      envToDelete: z.array(z.string()).optional(),
      terminalShellArgs: z.array(z.string()).optional(),
      worktreeId: z.string().optional(),
      historyIsolationEnabled: z.boolean().optional()
    })
  })
)
export const rexLaunchResult = lazyZodSchema(() =>
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(true),
    payload: z.instanceof(Uint8Array)
  })
)

export type RexLaunchJob = z.infer<typeof rexLaunchJob>
export type RexLaunchResponse = z.infer<typeof rexLaunchResult> | { id: number; ok: false }
