import { z } from 'zod'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'

export const WorktreeVisibilityDefaultsUpdate = z
  .object({
    external: z.enum(['hide', 'show']).optional(),
    customSources: z
      .unknown()
      .transform((value) => normalizeCustomWorktreeVisibilitySources(value))
      .optional(),
    sourcePreferences: z
      .unknown()
      .transform((value) => normalizeWorktreeVisibilitySourcePreferences(value))
      .optional()
  })
  .strict()
