import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type { WorktreeDisplayNameSource } from './worktree-display-name'

// What the session screen reads: the terminal inventory, the repo list two screens resolve a
// workspace's connection through, the session tab snapshot, native chat's workspace paths and
// older-history page, the quick-command list, the whole `worktree.show` record and a markdown
// tab's document. Checked against the handlers in src/main/runtime/rpc/methods/ — repo.ts:29,
// files.ts:27-56, session-tabs.ts:24, client-ui.ts:29-42, mobile-markdown-tab-methods.ts:6-20 —
// and the shared result types they return verbatim.

/**
 * The terminal inventory.
 *
 * `terminals` is a required array and each row needs the `handle` the screen keys it by:
 * use-mobile-session-terminal-list.ts:69 reads `.length` and :78 maps the handles, neither
 * guarded. The row is otherwise passed through, because the strip renders a host record this
 * module does not re-declare; a row with no handle drops rather than failing the refresh, which is
 * what a skip policy means for an inventory the screen treats as "no news".
 */
export const sessionTerminalInventorySchema = z.looseObject({
  terminals: salvagingArray(z.looseObject({ handle: z.string() }))
})

/**
 * The runtime repo list, narrowed to the member every consumer reaches for.
 *
 * `id` is what a workspace's repo is found by — mobile-new-tab-agent-loader.ts:63,
 * use-mobile-session-accessory-selection.ts:202 and use-mobile-native-chat-readability.ts:45 all
 * run `repos.find((repo) => repo.id === repoId)` — so a row without one can never match and drops.
 * The rest of each row passes through: three screens project it into three different repo shapes,
 * and re-declaring those here would make this reader the union of all of them.
 */
export const runtimeRepoListSchema = z
  .looseObject({ repos: salvagingArray(z.looseObject({ id: z.string() })) })
  .transform((reply) => reply.repos)

/**
 * The agents a host reports for a workspace.
 *
 * An array and nothing more: buildMobileNewTabAgentOptions spreads it
 * (mobile-new-tab-agent-options.ts:24) after a null check only, so a non-array reply was a
 * TypeError in the loader. Each element stays unknown because `isMobileTuiAgent` is the filter.
 */
export const detectedAgentsSchema = z.array(z.unknown())

/**
 * The workspace file paths native chat suggests, from either the search or the legacy inventory.
 *
 * The schema answers the path list itself rather than the host's row array, because that list is
 * all either call site ever wanted: an empty `relativePath` was already dropped. Nothing is
 * required: main's `?? []` made a reply without `files` an empty suggestion list, and a `files`
 * that is not an array was a `.map` on a string, which the salvaged optional turns into the same
 * empty list. What the schema adds is the container — a bare string reply is named rather than
 * crashing the composer's debounce.
 */
export const workspaceFilePathsSchema = z
  .looseObject({
    files: salvagedOptional(
      'files',
      salvagingArray(z.looseObject({ relativePath: salvagedOptional('relativePath', z.string()) }))
    )
  })
  .transform((reply) =>
    (reply.files ?? []).flatMap((file) => (file.relativePath ? [file.relativePath] : []))
  )

/**
 * The quick-command list, read the same way on load and on save.
 *
 * Nothing is required and the payload itself is nullish, because use-quick-commands.ts:20 reached
 * the member through `?.` and parseNormalizedTerminalQuickCommands answers null for anything it
 * cannot read — which both legs already turn into "Failed to load quick commands" rather than
 * adopting `[]`. What the schema adds is the container: a bare string reply is now named.
 */
export const terminalQuickCommandsSchema = z
  .looseObject({ terminalQuickCommands: z.unknown().optional() })
  .nullish()
  .transform((reply) => reply?.terminalQuickCommands)

/**
 * The `worktree.show` record, narrowed to the members its two consumers read.
 *
 * All four are optional: use-mobile-session-diff-comments.ts:42 reads `diffComments` through `?.`
 * and hands it to a normalizer that accepts anything, and getLiveWorktreeDisplayName reads the
 * other three behind `??` and `?.trim()`. The member itself is salvaged rather than required
 * because main read a record it could not parse as no record at all.
 */
export const sessionWorktreeRecordSchema = z
  .looseObject({
    worktree: salvagedOptional(
      'worktree',
      z.looseObject({
        worktreeId: salvagedOptional('worktreeId', z.string()),
        id: salvagedOptional('id', z.string()),
        displayName: salvagedOptional('displayName', z.string().nullable()),
        repo: salvagedOptional('repo', z.string().nullable()),
        diffComments: z.unknown().optional()
      })
    )
  })
  .transform(
    (reply): (WorktreeDisplayNameSource & { diffComments?: unknown }) | undefined => reply.worktree
  )

/**
 * A markdown tab's document, read the same way on load and on save.
 *
 * `content`, `version` and `isDirty` are required: use-mobile-session-document-readers.ts:38-45
 * publishes all three into the tab's ready state with no guard, so a reply missing one rendered
 * `undefined` in the editor and saved against an undefined base version.
 * `editable` and `readOnlyReason` are guarded on the same lines and stay optional.
 */
export const markdownTabDocumentSchema = z.looseObject({
  content: z.string(),
  version: z.string(),
  isDirty: z.boolean(),
  editable: salvagedOptional('editable', z.boolean()),
  readOnlyReason: salvagedOptional('readOnlyReason', z.string())
})

/**
 * The two replies a call site forwards opaquely.
 *
 * The session tab snapshot is handed to the reconciliation controller's own type parameter, which
 * no module-level reader can name, and the older-history page is a union an older runtime answers
 * `{ error }` to — a member reader would have to pick one arm before the caller discriminates.
 */
export const sessionForwardedReplySchema = z.unknown()
