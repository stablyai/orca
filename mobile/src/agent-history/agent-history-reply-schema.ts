import * as z from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/validation/zod-salvage'

// Schemas cover history/status and resume metadata from runtime RPC status, ai-vault, repo, folder-workspace and worktree-catalog methods; rows use shared AiVault types.

// Salvage capabilities: unreadable/missing list means unsupported. Keep entries open as vocabulary grows; known-token includes gates support.
// Pass remaining status fields through to total unknown guards for host platform/Windows shell rather than narrowing unused members.
export const agentHistoryHostStatusSchema = z.looseObject({
  capabilities: salvagedOptional('capabilities', z.array(z.string()))
})

// Require sessions/issues arrays: ready state maps/counts them directly, so missing containers crash rendering.
// Keep rows opaque: expanding agent vocabulary must survive newer hosts and echo back unchanged on resume; narrowing would reject/drop new sessions.
export const agentHistorySessionScanSchema = z.looseObject({
  sessions: z.array(z.unknown()),
  issues: z.array(z.unknown())
})

// Require repos array: null/non-array containers break return/member/find reads. Keep rows opaque so newer executionHostId spellings degrade in resolver, not reject whole catalog.
export const resumeRepoListSchema = z.looseObject({ repos: z.array(z.unknown()) })

// Check enrichment containers only: call-site readAcceptedResumeList degrades unreadable members to empty, but bare string replies otherwise silently resolved targets to unknown.
export const resumeMetadataListSchema = z.looseObject({})

// Project scope reads only which project each repo belongs to; an unreadable row drops alone.
export const agentHistoryProjectSetupsSchema = z.looseObject({
  setups: salvagingArray(z.object({ projectId: z.string(), repoId: z.string(), path: z.string() }))
})

// Either prompt may be missing: no text to hand over, or no saved transcript for Full transcript.
export const aiVaultSessionHandoffPromptSchema = z.looseObject({
  focused: salvagedOptional('focused', z.string()),
  full: salvagedOptional('full', z.string())
})
