import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import {
  connectRedmineSite,
  disconnectRedmineSite,
  getRedmineStatus,
  redmineReadErrorForCredentials,
  resolveRedmineCredentials,
  testRedmineConnection
} from '../../../redmine/client'
import { getRedmineIssue, listRedmineIssues, RedmineRequestError } from '../../../redmine/issues'

const SiteWithKey = z.object({
  siteUrl: requiredString('Server URL is required'),
  apiKey: requiredString('API key is required')
})

const SiteSelection = z
  .object({
    siteId: OptionalString
  })
  .optional()

const ListFilter = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  scope: z.enum(['assigned', 'created', 'all']).optional(),
  limit: OptionalFiniteNumber,
  page: OptionalFiniteNumber
})

const List = z
  .object({
    filter: ListFilter.optional()
  })
  .optional()

const IssueId = z.object({
  issueId: z.number()
})

// Why: the host owns the Redmine site store (~/.orca/redmine-sites.json +
// encrypted tokens), so it resolves the active site's credentials server-side,
// mirroring the main-process IPC handler via the shared resolver.
export const REDMINE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'redmine.status',
    params: null,
    handler: () => getRedmineStatus()
  }),
  defineMethod({
    name: 'redmine.testConnection',
    params: SiteWithKey,
    handler: async (params) => {
      const result = await testRedmineConnection(params.siteUrl.trim(), params.apiKey.trim())
      if (!result.user || result.error) {
        return {
          ok: false as const,
          error: result.error ?? { type: 'unknown', message: 'Unable to connect.' }
        }
      }
      return { ok: true as const, user: result.user }
    }
  }),
  defineMethod({
    name: 'redmine.connect',
    params: SiteWithKey,
    handler: async (params) => connectRedmineSite(params.siteUrl.trim(), params.apiKey.trim())
  }),
  defineMethod({
    name: 'redmine.disconnect',
    params: SiteSelection,
    handler: (params) => {
      if (params?.siteId) {
        disconnectRedmineSite(params.siteId)
      }
    }
  }),
  defineMethod({
    name: 'redmine.listIssues',
    params: List,
    handler: async (params) => {
      const creds = resolveRedmineCredentials()
      if (!creds.ok) {
        return {
          items: [],
          totalCount: 0,
          error: redmineReadErrorForCredentials(creds.reason)
        }
      }
      try {
        return await listRedmineIssues(creds.siteUrl, creds.apiKey, params?.filter ?? {})
      } catch (error) {
        if (error instanceof RedmineRequestError) {
          return { items: [], totalCount: 0, error: error.classified }
        }
        throw error
      }
    }
  }),
  defineMethod({
    name: 'redmine.getIssue',
    params: IssueId,
    handler: async (params) => {
      const creds = resolveRedmineCredentials()
      if (!creds.ok) {
        return { issue: null, error: redmineReadErrorForCredentials(creds.reason) }
      }
      try {
        return { issue: await getRedmineIssue(creds.siteUrl, creds.apiKey, params.issueId) }
      } catch (error) {
        if (error instanceof RedmineRequestError) {
          return { issue: null, error: error.classified }
        }
        throw error
      }
    }
  })
]
