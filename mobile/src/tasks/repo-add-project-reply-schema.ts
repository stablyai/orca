import { z } from 'zod'
import { fileDirectoryEntriesSchema } from '../files/file-explorer-reply-schema'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

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
    displayName: z.string(),
    connectionId: salvagedOptional('connectionId', z.string().nullable()),
    executionHostId: salvagedOptional('executionHostId', z.string().nullable())
  })
})

export type RepoCreateReply =
  | { error: string }
  | {
      repo: {
        id: string
        path: string
        displayName: string
        connectionId?: string | null
        executionHostId?: string | null
      }
    }

// Annotated rather than inferred so `'error' in reply` narrows at the call site: a
// `looseObject`'s index signature puts `error` on both arms as far as the checker is
// concerned. The runtime object still carries every member the host sent.
export const repoCreateResultSchema: z.ZodType<RepoCreateReply, unknown> = z.union([
  z.looseObject({ error: z.string() }),
  repoAddProjectReceiptSchema
])

/**
 * files.browseServerDir — the host filesystem the Add project sheet walks to pick an existing
 * project folder. Checked against src/main/runtime/runtime-server-environment-commands.ts:28-55.
 *
 * `resolvedPath` is required and read unguarded: the sheet joins it with the tapped row's name to
 * step into a directory, so a reply without it would navigate to `undefined/<name>`. Rows carry the
 * same DirEntry trio as the Files tab, which is why the row reader is shared rather than restated.
 * `pathFlavor` is not declared — the sheet joins with the separator it detects, and the drive list
 * a Windows host answers for a drive-list request is just a listing of directories.
 */
export const serverDirectoryBrowseSchema = z.looseObject({
  resolvedPath: z.string(),
  entries: fileDirectoryEntriesSchema
})
