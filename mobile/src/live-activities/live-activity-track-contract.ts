import * as z from 'zod'

export const liveActivityTrackParamsSchema = z
  .object({
    worktreeId: z.string().min(1).max(2048),
    paneKey: z.string().min(1).max(2048),
    executionHost: z
      .string()
      .max(2048)
      .regex(/^runtime:[^|\s]+$/)
      .optional(),
    turnKey: z.string().min(1).max(256)
  })
  .strict()
export type LiveActivityTrackParams = z.infer<typeof liveActivityTrackParamsSchema>
