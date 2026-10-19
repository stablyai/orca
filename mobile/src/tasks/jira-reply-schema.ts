import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Required identity fields reject unusable rows; optional fields salvage older-host replies.

const text = (name: string) => salvagedOptional(name, z.string())

const jiraSiteRow = z.looseObject({
  id: z.string(),
  siteUrl: z.string(),
  displayName: z.string(),
  email: text('email').transform((value) => value ?? ''),
  accountId: text('accountId').transform((value) => value ?? ''),
  authType: salvagedOptional('authType', z.enum(['cloud', 'server']))
})

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

export const jiraIssueListSchema = z.union([
  salvagingArray(jiraIssueRowSchema),
  z
    .looseObject({ items: salvagingArray(jiraIssueRowSchema) })
    .transform((envelope) => envelope.items),
  z
    .looseObject({ issues: salvagingArray(jiraIssueRowSchema) })
    .transform((envelope) => envelope.issues)
])

export const jiraCommentListSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    body: z.string(),
    createdAt: text('createdAt'),
    user: salvagedOptional('user', jiraUser)
  })
)
