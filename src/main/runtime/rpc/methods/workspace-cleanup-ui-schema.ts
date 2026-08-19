import { z } from 'zod'
import {
  normalizeWorkspaceCleanupBrowseState,
  type WorkspaceCleanupBrowseState
} from '../../../../shared/workspace-cleanup-browse-state'

const WorkspaceCleanupDismissal = z.object({
  worktreeId: z.string(),
  dismissedAt: z.number().finite(),
  fingerprint: z.string(),
  classifierVersion: z.number().finite(),
  executionHostId: z.string().min(1).optional()
})

/**
 * Deliberately unvalidated shape, then normalized: the filter groups must NOT be
 * strict or enumerated here. A newer client sends filters this build has never
 * heard of, and a per-field zod shape would reject the whole `ui.set` payload
 * instead of persisting the parts the host does understand. The shared
 * normalizer never throws and degrades field by field, so an older host narrows
 * the state rather than refusing it.
 */
const WorkspaceCleanupBrowse = z
  .custom<WorkspaceCleanupBrowseState>()
  .transform((value) => normalizeWorkspaceCleanupBrowseState(value))

export const WorkspaceCleanup = z.object({
  dismissals: z.record(z.string(), WorkspaceCleanupDismissal),
  browse: WorkspaceCleanupBrowse.optional()
})
