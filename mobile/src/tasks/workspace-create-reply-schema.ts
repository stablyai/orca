import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Creating a workspace from a task. Checked against src/main/runtime/rpc/methods/worktree.ts:76-208
// (RuntimeWorktreeCreateResult, and the `GitHubPrStartPoint | { error }` pair the two base
// resolvers answer) and agent-launch.ts (AgentLaunchResult, src/shared/agent-launch-intent.ts:88).

const createText = (name: string) => salvagedOptional(name, z.string())

/**
 * A created workspace.
 *
 * `worktree.id` is the requirement: use-mobile-tasks-workspace-create-actions.tsx:272 routes to
 * `/session/${result.worktree.id}` and :266 reads `result.worktree.displayName`, neither guarded,
 * so a reply without the record navigated the phone to `/session/undefined`. Every recorded create
 * carries it — `tw-create-retry-created`, `tw-create-retry-warning-kept`,
 * `settings-task-workspace-create-linear` and its pr-start-point sibling.
 *
 * `z.string()` and not `.min(1)`: worktree-create-retry.ts:158 rejects an empty id itself and
 * answers "Failed to create workspace", and that arm stays reachable rather than becoming a decode
 * failure.
 *
 * `warning` is optional and untrimmed. Both readers trim it themselves (:268 and
 * worktree-create-retry.ts:169), and `tw-create-retry-warning-kept` records the host sending
 * `"  startup terminal failed  "` — normalising it here would move that golden.
 */
export const worktreeCreateReceiptSchema = z.looseObject({
  worktree: z.looseObject({ id: z.string(), displayName: createText('displayName') }),
  warning: createText('warning')
})

/**
 * An `agent.launch` receipt for a create.
 *
 * Nothing under the container is required, because readAgentLaunchCreateOutcome already guards
 * every member it reads — `'worktreeId' in result` and a `typeof`/`trim` pair
 * (agent-launch-worktree-create.ts:55-:64) — and answers `null` when either fails, which
 * worktree-create-retry.ts:123 turns into "Failed to create workspace". That arm is preserved.
 *
 * What the container adds is the reply main could not name: a string, a number or `null` receipt
 * reached the same "Failed to create workspace" copy as a receipt that simply had no id, so a host
 * answering the wrong shape was indistinguishable from one that could not create.
 *
 * `outcome`, `receipt` and `prompt` are `unknown`. The reader is deliberately mode-blind — the
 * host has already published and activated the surface before answering — so nothing here branches
 * on them and declaring them would be a requirement with no reader.
 */
export const agentLaunchCreateReceiptSchema = z.looseObject({
  worktreeId: createText('worktreeId'),
  warning: createText('warning'),
  outcome: z.unknown().optional(),
  receipt: z.unknown().optional(),
  prompt: z.unknown().optional()
})

/**
 * A linked pull request's or merge request's start point.
 *
 * A union, because the consumer's own test is `'error' in result`
 * (composer-source-base-resolve.ts:36/:65, use-mobile-tasks-workspace-create-actions.tsx:185/:226)
 * and `in` on a non-object was a TypeError. The soft-error arm comes first for the same reason
 * main's branch does, and it keeps an empty message verbatim — `tw-hosted-base-soft-error` records
 * the host answering `{ error: '' }`, which the create surfaces as its own copy.
 *
 * `baseBranch` is required on the resolved arm: it is the whole point of the call, and every
 * recorded success carries it (`tw-hosted-base-resolved`, `settings-task-workspace-create-pr-start-
 * point`). Everything beside it is optional and passes through, because the create params spread
 * the record and the host reads what it recognises.
 */
export type WorktreeHostedBaseReply =
  | { error: string }
  | {
      baseBranch: string
      compareBaseRef?: string
      branchNameOverride?: string
      headSha?: string
      maintainerCanModify?: boolean
      pushTarget?: unknown
    }

// Annotated rather than inferred so `'error' in result` narrows at the four call sites: a
// `looseObject`'s index signature puts `error` on both arms as far as the checker is concerned.
// The runtime object still carries every member the host sent, which is what the create spreads.
export const worktreeHostedBaseSchema: z.ZodType<WorktreeHostedBaseReply, unknown> = z.union([
  z.looseObject({ error: z.string() }),
  z.looseObject({
    baseBranch: z.string(),
    compareBaseRef: createText('compareBaseRef'),
    branchNameOverride: createText('branchNameOverride'),
    headSha: createText('headSha'),
    maintainerCanModify: salvagedOptional('maintainerCanModify', z.boolean()),
    pushTarget: z.unknown().optional()
  })
])
