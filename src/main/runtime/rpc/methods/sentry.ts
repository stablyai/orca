import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalPlainString, requiredString } from '../schemas'

const Connect = z.object({
  baseUrl: requiredString('Base URL is required'),
  token: requiredString('Auth token is required'),
  organizationSlug: OptionalPlainString
})
const SelectOrganization = z.object({ slug: requiredString('Organization is required') })
const IssueQuery = z
  .object({
    query: OptionalPlainString,
    projects: z.array(z.string()).optional(),
    environments: z.array(z.string()).optional(),
    statsPeriod: OptionalPlainString,
    sort: z.enum(['date', 'freq', 'inbox', 'new', 'recommended', 'trends', 'user']).optional(),
    cursor: OptionalPlainString,
    limit: OptionalFiniteNumber
  })
  .optional()
const IssueId = z.object({ issueId: requiredString('Issue ID is required') })
const Events = IssueId.extend({ cursor: OptionalPlainString })
const Update = IssueId.extend({
  updates: z.object({
    status: z.enum(['resolved', 'unresolved', 'ignored']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    assignedTo: z.string().nullable().optional()
  })
})

export const SENTRY_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'sentry.connect',
    params: Connect,
    handler: (p, { runtime }) => runtime.sentryConnect(p)
  }),
  defineMethod({
    name: 'sentry.disconnect',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryDisconnect()
  }),
  defineMethod({
    name: 'sentry.selectOrganization',
    params: SelectOrganization,
    handler: (p, { runtime }) => runtime.sentrySelectOrganization(p.slug.trim())
  }),
  defineMethod({
    name: 'sentry.status',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryStatus()
  }),
  defineMethod({
    name: 'sentry.testConnection',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryTestConnection()
  }),
  defineMethod({
    name: 'sentry.listProjects',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryListProjects()
  }),
  defineMethod({
    name: 'sentry.listEnvironments',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryListEnvironments()
  }),
  defineMethod({
    name: 'sentry.listAssignees',
    params: null,
    handler: (_p, { runtime }) => runtime.sentryListAssignees()
  }),
  defineMethod({
    name: 'sentry.listIssues',
    params: IssueQuery,
    handler: (p, { runtime, signal }) => runtime.sentryListIssues(p ?? {}, signal)
  }),
  defineMethod({
    name: 'sentry.getIssue',
    params: IssueId,
    handler: (p, { runtime }) => runtime.sentryGetIssue(p.issueId.trim())
  }),
  defineMethod({
    name: 'sentry.listEvents',
    params: Events,
    handler: (p, { runtime, signal }) =>
      runtime.sentryListEvents(p.issueId.trim(), p.cursor, signal)
  }),
  defineMethod({
    name: 'sentry.updateIssue',
    params: Update,
    handler: (p, { runtime }) => runtime.sentryUpdateIssue(p.issueId.trim(), p.updates)
  })
]
