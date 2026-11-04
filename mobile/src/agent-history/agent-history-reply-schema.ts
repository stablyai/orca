import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Schemas cover history/status and resume metadata from runtime RPC status, ai-vault, repo, folder-workspace and worktree-catalog methods; rows use shared AiVault types.

/** Salvage capabilities: an unreadable list means unsupported. Remaining fields stay open for host platform and Windows shell readers. */
export const agentHistoryHostStatusSchema = z.looseObject({
  capabilities: salvagedOptional('capabilities', z.array(z.string()))
})

/** Require sessions and issues arrays. Rows stay opaque so a newer host's session fields survive resume. */
export const agentHistorySessionScanSchema = z.looseObject({
  sessions: z.array(z.unknown()),
  issues: z.array(z.unknown()),
  fingerprint: z.string().optional(),
  unchanged: z.boolean().optional()
})

/** Require a repos array. Rows stay opaque so a new executionHostId spelling degrades in the resolver. */
export const resumeRepoListSchema = z.looseObject({ repos: z.array(z.unknown()) })

/** Check that metadata replies are objects. Member reads degrade unreadable fields to empty. */
export const resumeMetadataListSchema = z.looseObject({})
