import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

const VALID_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

const SiteSelection = z
  .object({
    siteId: OptionalString
  })
  .optional()

const Connect = z.object({
  siteUrl: requiredString('Site URL is required'),
  email: requiredString('Email is required'),
  apiToken: requiredString('API token is required')
})

const SelectSite = z.object({
  siteId: requiredString('Site ID is required')
})

const SearchIssues = z.object({
  jql: requiredString('Missing JQL'),
  limit: OptionalFiniteNumber,
  siteId: OptionalString
})

const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    siteId: OptionalString
  })
  .optional()

const IssueKey = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString
})

const CreateIssue = z.object({
  siteId: OptionalString,
  projectId: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  title: requiredString('Title is required'),
  description: OptionalPlainString,
  customFields: z.record(z.string(), z.unknown()).optional()
})

const IssueUpdate = z.object({
  key: requiredString('Issue key is required'),
  siteId: OptionalString,
  updates: z.object({
    title: OptionalString,
    labels: z.array(z.string()).optional(),
    assigneeAccountId: z.union([z.string(), z.null()]).optional(),
    priorityId: z.union([z.string(), z.null()]).optional(),
    transitionId: OptionalString
  })
})

const IssueComment = z.object({
  key: requiredString('Issue key is required'),
  body: requiredString('Comment body is required'),
  siteId: OptionalString
})

const ProjectIssueTypes = z.object({
  projectIdOrKey: requiredString('Project is required'),
  siteId: OptionalString
})

const ProjectIssueTypeFields = z.object({
  projectIdOrKey: requiredString('Project is required'),
  issueTypeId: requiredString('Issue type is required'),
  siteId: OptionalString
})

const AssignableUsers = z.object({
  key: requiredString('Issue key is required'),
  query: OptionalPlainString,
  siteId: OptionalString
})

export const JIRA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'jira.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.jiraConnect({
        siteUrl: params.siteUrl.trim(),
        email: params.email.trim(),
        apiToken: params.apiToken.trim()
      })
  }),
  defineMethod({
    name: 'jira.disconnect',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraDisconnect(params?.siteId)
  }),
  defineMethod({
    name: 'jira.selectSite',
    params: SelectSite,
    handler: async (params, { runtime }) => runtime.jiraSelectSite(params.siteId.trim())
  }),
  defineMethod({
    name: 'jira.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.jiraStatus()
  }),
  defineMethod({
    name: 'jira.testConnection',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraTestConnection(params?.siteId)
  }),
  defineMethod({
    name: 'jira.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.jiraSearchIssues(params.jql, params.limit, params.siteId)
  }),
  defineMethod({
    name: 'jira.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssues(params?.filter, params?.limit, params?.siteId)
  }),
  defineMethod({
    name: 'jira.getIssue',
    params: IssueKey,
    handler: async (params, { runtime }) => runtime.jiraGetIssue(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.jiraCreateIssue({
        siteId: params.siteId,
        projectId: params.projectId.trim(),
        issueTypeId: params.issueTypeId.trim(),
        title: params.title.trim(),
        description: params.description?.trim() || undefined,
        customFields: params.customFields
      })
  }),
  defineMethod({
    name: 'jira.updateIssue',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.jiraUpdateIssue(params.key.trim(), params.updates, params.siteId)
  }),
  defineMethod({
    name: 'jira.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.jiraAddIssueComment(params.key.trim(), params.body.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.issueComments',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraIssueComments(params.key.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.listProjects',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListProjects(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listIssueTypes',
    params: ProjectIssueTypes,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssueTypes(params.projectIdOrKey.trim(), params.siteId)
  }),
  defineMethod({
    name: 'jira.listCreateFields',
    params: ProjectIssueTypeFields,
    handler: async (params, { runtime }) =>
      runtime.jiraListCreateFields(
        params.projectIdOrKey.trim(),
        params.issueTypeId.trim(),
        params.siteId
      )
  }),
  defineMethod({
    name: 'jira.listPriorities',
    params: SiteSelection,
    handler: async (params, { runtime }) => runtime.jiraListPriorities(params?.siteId)
  }),
  defineMethod({
    name: 'jira.listAssignableUsers',
    params: AssignableUsers,
    handler: async (params, { runtime }) =>
      runtime.jiraListAssignableUsers(params.key.trim(), params.query, params.siteId)
  }),
  defineMethod({
    name: 'jira.listTransitions',
    params: IssueKey,
    handler: async (params, { runtime }) =>
      runtime.jiraListTransitions(params.key.trim(), params.siteId)
  })
]
