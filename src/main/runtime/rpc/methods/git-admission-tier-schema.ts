import { z } from 'zod'
import type { GitAdmissionTier } from '../../../git/command-runner/git-exec-options'

export const OptionalGitAdmissionTier = z
  .unknown()
  .optional()
  .transform((value): GitAdmissionTier | undefined => {
    return value === 'interactive' || value === 'status' || value === 'background'
      ? value
      : undefined
  })
