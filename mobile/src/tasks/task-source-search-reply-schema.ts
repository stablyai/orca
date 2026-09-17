import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The Smart workspace-source picker's provider reads: per-repo search, and the single-item lookups
// a pasted link or number resolves to. Checked against
// src/main/runtime/rpc/methods/github-repo-work-item-methods.ts:30-81 (ListWorkItemsResult, whose
// declared invariant is that `items` always carries whatever succeeded), gitlab.ts:40-49 and
// gitlab.ts:180-190, and linear.ts:50-60.
//
// Work-item rows stay thin on identity: `id`, `number`, `title`, `state` and `url` are all read
// through a guard or rendered as text, so typing them is enough and requiring one would drop a row
// for a member no reader can crash on. `labels` is the exception and is required — see below.

const itemText = (name: string) => salvagedOptional(name, z.string())
const itemCount = (name: string) => salvagedOptional(name, z.number())

/** A provider work-item row, typed but not required. `repoId` is stamped by the caller, never
 *  read off the reply. */
const workItemRow = z.looseObject({
  id: itemText('id'),
  type: itemText('type'),
  number: itemCount('number'),
  title: itemText('title'),
  state: itemText('state'),
  url: itemText('url'),
  updatedAt: itemText('updatedAt'),
  // Required: both label editors read `item.source.labels.filter(...)` with no guard
  // (use-mobile-tasks-hosted-metadata-actions.tsx:160,
  // use-mobile-tasks-gitlab-github-status-actions.tsx:110), and `labels: string[]` is non-optional
  // on both host types (src/shared/github/work-item-types.ts:23, src/shared/gitlab-types.ts:172).
  // A row missing it drops out of the list instead of throwing inside the editor's `onPress`.
  labels: salvagingArray(z.string()),
  // Tri-state and preserved: GitHubWorkItem/GitLabWorkItem declare `author: string | null`, and
  // the row renderer shows an explicit null differently from a host that never reported one.
  author: salvagedOptional('author', z.string().nullable())
})

/**
 * The GitHub work-item list.
 *
 * `items` is required. use-mobile-tasks-provider-load-actions.tsx:138 maps it with no guard, and
 * the host's own envelope declares the invariant ("`items` always contains whatever succeeded",
 * src/shared/github/work-item-types.ts:96) — so an absent `items` is a reply this app cannot read,
 * not an empty page. smart-source-search-requests.ts:43 maps the same array.
 *
 * `sources`, `errors` and `issueSourceFellBack` pass through untyped beyond their container: the
 * banner extractors read them member by member with their own guards, and `sources.issues` is a
 * bare string in the recorded `tk-provider-load` reply where the shared type declares an
 * owner/repo object.
 */
export const taskGitHubWorkItemListSchema = z.looseObject({
  items: salvagingArray(workItemRow),
  sources: z.unknown().optional(),
  errors: z.unknown().optional(),
  issueSourceFellBack: z.unknown().optional()
})

/**
 * The GitLab work-item list.
 *
 * `items` is required for the same reason: use-mobile-tasks-task-list-loading.tsx:183 maps it
 * unguarded. `error` is the provider's in-band failure and stays optional — both consumers test
 * `envelope.error?.type` before reading `.message`, and `tw-smart-search-all-providers` records a
 * reply carrying items AND a `not_found` error at once, which the list renders rather than raises.
 */
export const taskGitLabWorkItemListSchema = z.looseObject({
  items: salvagingArray(workItemRow),
  error: salvagedOptional(
    'error',
    z.looseObject({ type: itemText('type'), message: itemText('message') })
  )
})

/**
 * A Linear issue list, in either shape the picker has always accepted.
 *
 * The host answers a bare array from `linear.searchIssues` and an `{ items }` envelope from
 * `linear.listIssues`, and `tasks.smart-source-search` records both. The union replaces the hand
 * reader in linear-mobile-issue-read.ts, whose `throw new Error('Unexpected Linear tasks
 * response')` reached the screen as its own copy; the same payloads are now named as an
 * incompatible `linear.searchIssues` / `linear.listIssues` reply.
 *
 * Required: `id`, `state.name`, `team.name` and `priority`. `createLinearTask` reads
 * `issue.state.name` and `issue.team.name` with no guard (mobile-tasks-item-mapping.ts:296-297),
 * so a row without either is a TypeError the moment the row is mapped, and
 * `getLinearPriorityRank(issue.priority)` feeds `a.priority - b.priority`
 * (mobile-tasks-reviewer-linear.ts:99-101), where an absent priority makes the whole comparator
 * NaN and orders the reviewer list arbitrarily. All four are non-optional on the host's own type
 * (src/shared/linear/issue-types.ts:3-33), which is what `linear.searchIssues` and
 * `linear.listIssues` return (linear.ts:50-56, linear-issue-list-method.ts:5-16).
 *
 * The rest are typed and optional because none of them can throw: `identifier`, `title` and
 * `updatedAt` are interpolated or handed to `Intl.Collator`, which coerce rather than crash.
 *
 * The earlier version of this schema required `id` alone, on the grounds that the recorded
 * smart-search rows were `{ id: 'issue-1' }`. Those rows were a fixture defect, not evidence: no
 * Linear issue the host can build lacks `state` or `team`. The fixtures now carry real rows and
 * main's rendering of them is recorded before this requirement lands.
 */
const linearIssueRow = z.looseObject({
  id: z.string(),
  identifier: itemText('identifier'),
  title: itemText('title'),
  url: itemText('url'),
  updatedAt: itemText('updatedAt'),
  priority: z.number(),
  state: z.looseObject({ name: z.string(), color: itemText('color'), type: itemText('type') }),
  team: z.looseObject({ id: itemText('id'), name: z.string(), key: itemText('key') })
})

export const taskLinearIssueListSchema = z.union([
  salvagingArray(linearIssueRow),
  z.looseObject({ items: salvagingArray(linearIssueRow) }).transform((reply) => reply.items)
])

/**
 * A single work item, or `null` when the provider has none.
 *
 * Null is preserved rather than refused: both `github.workItem` and `gitlab.workItemByPath` answer
 * it for a number that does not resolve, and every consumer already spells `item ? … : null`
 * (smart-source-paste-intent.ts:151/:171/:188).
 *
 * The row is the same `workItemRow`, with no `iid` extension: neither GitHubWorkItem nor
 * GitLabWorkItem declares one, the GitLab consumers all build their `iid` param out of
 * `item.source.number` (use-mobile-tasks-gitlab-github-status-actions.tsx:50 and four siblings),
 * and the `{ iid: 7 }` the fixture used to record was the same defect as the Linear `{ id }` rows.
 */
export const taskWorkItemLookupSchema = workItemRow.nullable()
