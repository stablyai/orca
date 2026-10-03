import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The read-only Jira surface mobile is allowed to call, checked against
// src/main/runtime/rpc/methods/jira.ts and the shapes its runtime returns
// (src/shared/jira-types.ts). Connect/disconnect and every write stay on desktop, so no schema
// here describes one.

const text = (name: string) => salvagedOptional(name, z.string())

/**
 * A Jira site row.
 *
 * `id` and `siteUrl` are required: the site picker keys its rows by `id`
 * (mobile-tasks-filter-pickers.tsx) and `jiraSiteLabel` falls back to `siteUrl` when the display
 * name is blank, both unguarded. A row missing either drops out of the picker rather than
 * rendering a site nothing can select.
 */
const jiraSiteRow = z.looseObject({
  id: z.string(),
  siteUrl: z.string(),
  displayName: z.string(),
  email: text('email'),
  accountId: text('accountId'),
  authType: text('authType')
})

/**
 * `jira.status`.
 *
 * Only `connected` is required — it is the whole verdict, and `extractJiraConnection` reads every
 * other member behind its own guard. `sites` salvages per row so one malformed site does not cost
 * the connection.
 */
export const jiraConnectionStatusSchema = z.looseObject({
  connected: z.boolean(),
  sites: salvagedOptional('sites', salvagingArray(jiraSiteRow)),
  activeSiteId: salvagedOptional('activeSiteId', z.string().nullable()),
  selectedSiteId: salvagedOptional('selectedSiteId', z.string().nullable()),
  credentialError: text('credentialError'),
  viewer: z.unknown().optional()
})

const jiraProject = z.looseObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  siteId: text('siteId'),
  siteName: text('siteName')
})

const jiraNamed = z.looseObject({ id: z.string(), name: z.string() })

const jiraUser = z.looseObject({
  accountId: z.string(),
  displayName: z.string(),
  avatarUrl: text('avatarUrl')
})

/**
 * A Jira issue row.
 *
 * `key`, `title`, `url` and `updatedAt` are required because the list row and the workspace-create
 * payload read all four unguarded (mobile-tasks-item-mapping.ts, workspace-create-params.ts).
 * `project`, `issueType` and `status` are required for the same reason: the detail sheet reads
 * `issue.project.name`, `issue.issueType.name` and the status name with no fallback.
 * `labels` is required because the detail payload spreads it. The remaining required members are
 * the ones `JiraIssue` itself declares non-optional, so a decoded row is the shared type rather
 * than a widened stand-in a cast would have to close.
 */
export const jiraIssueRowSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
  description: text('description'),
  siteId: text('siteId'),
  siteName: text('siteName'),
  project: jiraProject,
  issueType: jiraNamed,
  status: z.looseObject({
    id: z.string(),
    name: z.string(),
    categoryKey: z.string(),
    categoryName: z.string(),
    colorName: text('colorName')
  }),
  labels: salvagingArray(z.string()),
  assignee: salvagedOptional('assignee', jiraUser),
  reporter: salvagedOptional('reporter', jiraUser),
  priority: salvagedOptional('priority', jiraNamed)
})

/**
 * A Jira issue list, in either shape the screen has always accepted: the runtime answers a bare
 * array today, and an older or stream-wrapped host hands back an `{ items }` / `{ issues }`
 * envelope. This replaces the hand reader in jira-mobile-issue-read.ts, whose
 * `throw new Error('Unexpected Jira tasks response')` reached the screen as unattributed copy.
 */
export const jiraIssueListSchema = z.union([
  salvagingArray(jiraIssueRowSchema),
  z
    .looseObject({ items: salvagingArray(jiraIssueRowSchema) })
    .transform((envelope) => envelope.items),
  z
    .looseObject({ issues: salvagingArray(jiraIssueRowSchema) })
    .transform((envelope) => envelope.issues)
])

/**
 * `jira.issueComments`. Best-effort in the detail sheet: a comment missing `id` is dropped rather
 * than failing the issue it belongs to, which is what `toJiraDetailComments` already did by hand.
 */
export const jiraCommentListSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    body: z.string(),
    createdAt: z.string(),
    user: salvagedOptional('user', jiraUser)
  })
)
