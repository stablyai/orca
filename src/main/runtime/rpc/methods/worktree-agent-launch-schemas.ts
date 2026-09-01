import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { isCanonicalLowercaseUuid } from '../../../agent-launch/agent-launch-operation-store'
import { WorktreeSelector } from './worktree-schemas'

// clientMutationId is required in canonical lowercase UUID form BEFORE any
// idempotency lookup/write; expectedFailureId is an anti-race guard shown in
// client metadata, never an authorization secret.
export const WorktreeRetryAgentLaunch = WorktreeSelector.extend({
  expectedFailureId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  }),
  action: z.union([
    z.object({ kind: z.literal('retry-same') }),
    z.object({
      kind: z.literal('change-agent'),
      agent: z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown agent' })
    })
  ])
})

export const WorktreeForgetAgentLaunch = WorktreeSelector.extend({
  // expectedOperationId is an anti-race guard from client-visible worktree
  // metadata, never authorization.
  expectedOperationId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  })
})

// Generic background attempt Forget/Retry (U6). Keyed by the host-minted attempt
// id (not a worktree selector — a worktree may host several background attempts),
// which is client-visible attempt metadata and an anti-race guard, never a secret.
export const WorktreeRetryBackgroundAgentLaunch = z.object({
  attemptId: z.string().min(1).max(256),
  expectedFailureId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  }),
  action: z.union([
    z.object({ kind: z.literal('retry-same') }),
    z.object({
      kind: z.literal('change-agent'),
      agent: z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown agent' })
    })
  ])
})

export const WorktreeForgetBackgroundAgentLaunch = z.object({
  attemptId: z.string().min(1).max(256),
  expectedOperationId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  })
})

// The capacity-recovery summary takes no params: the principal is scoped from the
// authenticated clientKind, never from client JSON, so there is nothing to carry.
export const WorktreePendingAgentLaunchSummary = z.object({})

// Same-principal bulk forget (§U9 ledger #15 / plan :498). Both carry only the
// anchor worktree selector: the principal is scoped from the authenticated
// clientKind, the disconnected host + eligible siblings are derived host-side, and
// no per-launch operation id fits a bulk op — every sibling self-guards internally.
export const WorktreeUnknownAgentLaunchSiblingCount = WorktreeSelector
export const WorktreeForgetUnknownAgentLaunchSiblings = WorktreeSelector
