import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The Smart workspace-source picker's provider reads: per-repo search, and the single-item lookups
// a pasted link or number resolves to. Checked against
// src/main/runtime/rpc/methods/github-repo-work-item-methods.ts:30-81 (ListWorkItemsResult, whose
// declared invariant is that `items` always carries whatever succeeded), gitlab.ts:40-49 and
// gitlab.ts:180-190, and linear.ts:50-60.
//
// Work-item rows are deliberately thin. `tw-smart-search-all-providers` records
// `github.listWorkItems` answering `{ items: [{ number: 1, title: 'one' }] }` and
// `gitlab.workItemByPath` answering `{ iid: 7, title: 'seven' }`, so the identity members the
// shared types declare non-optional are not on the wire in this corpus. Requiring one would drop
// the row out of a partition main renders — the schema types what is there and requires nothing
// the recorded success does not carry.

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
  labels: salvagedOptional('labels', salvagingArray(z.string())),
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
 * not an empty page. The smart picker's own `?? []` at smart-source-search-requests.ts:43 stays
 * where it is; it now only covers the empty array.
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
 * `items` is required for the same reason: use-mobile-tasks-task-list-loading.tsx:182 maps it
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
 * `id` is the only requirement, because it is the row key (mobile-tasks-item-mapping.ts:293) and
 * because it is the ONLY member the recorded smart-search success carries: that fixture's issues
 * are `{ id: 'issue-1' }`. `state` and `team` are read unguarded downstream
 * (mobile-tasks-item-mapping.ts:296-:297) but are left optional for exactly that reason — a
 * requirement here would drop every row out of a partition main renders.
 */
const linearIssueRow = z.looseObject({
  id: z.string(),
  identifier: itemText('identifier'),
  title: itemText('title'),
  url: itemText('url'),
  updatedAt: itemText('updatedAt'),
  priority: itemCount('priority'),
  state: salvagedOptional(
    'state',
    z.looseObject({ name: itemText('name'), color: itemText('color'), type: itemText('type') })
  ),
  team: salvagedOptional(
    'team',
    z.looseObject({ id: itemText('id'), name: itemText('name'), key: itemText('key') })
  )
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
 * (smart-source-paste-intent.ts:152/:172/:189). Nothing inside is required, because the recorded
 * `tw-paste-lookup-resolved` items are `{ number: 12, title: 'twelve' }` and `{ iid: 7, title:
 * 'seven' }` — the GitLab one does not even carry `number`.
 */
export const taskWorkItemLookupSchema = workItemRow.extend({ iid: itemCount('iid') }).nullable()
