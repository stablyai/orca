import { z } from 'zod'

// Bringing a new project onto the paired host from the Add project sheet. Checked against
// src/main/runtime/rpc/methods/repo.ts:105-137: repo.add and repo.clone answer `{ repo }` and
// throw their failures, while repo.create answers the soft `{ repo } | { error }` pair the
// caller raises itself — the same convention worktreeHostedBaseSchema holds for its base
// resolvers.

/**
 * A repo row the host registered. `id`, `path` and `displayName` are the requirement: the
 * Add project sheet upserts the row straight into the New workspace form's repo list
 * (use-new-workspace-repositories.ts), which reads all three unguarded. Every row the host
 * stores carries them — displayName falls back to the path's basename at store time.
 */
export const repoAddProjectReceiptSchema = z.looseObject({
  repo: z.looseObject({
    id: z.string(),
    path: z.string(),
    displayName: z.string()
  })
})

export type RepoCreateReply =
  | { error: string }
  | { repo: { id: string; path: string; displayName: string } }

// Annotated rather than inferred so `'error' in reply` narrows at the call site: a
// `looseObject`'s index signature puts `error` on both arms as far as the checker is
// concerned. The runtime object still carries every member the host sent.
export const repoCreateResultSchema: z.ZodType<RepoCreateReply, unknown> = z.union([
  z.looseObject({ error: z.string() }),
  repoAddProjectReceiptSchema
])
