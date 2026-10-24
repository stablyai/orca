import type {
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraTransition,
  JiraUser
} from '../../shared/jira/jira-types'
import { isResolvedJiraIssueMatch, parseJiraIssueUrl } from '../../shared/jira-issue-url'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import {
  formatJiraCommentList,
  formatJiraIssue,
  formatJiraIssueList,
  formatJiraIssueTypeList,
  formatJiraPriorityList,
  formatJiraProjectList,
  formatJiraTransitionList,
  formatJiraUserList
} from '../jira-format'
import { resolveJiraTarget } from '../jira-target'
import { RuntimeClientError } from '../runtime-client'
import { JIRA_WRITE_HANDLERS } from './jira-write'

function issueTarget(context: HandlerContext) {
  return resolveJiraTarget(context, getRequiredStringFlag(context.flags, 'key'))
}

function parseFilter(context: HandlerContext): JiraIssueFilter | undefined {
  const value = getOptionalStringFlag(context.flags, 'filter')?.trim().toLowerCase()
  if (
    value === undefined ||
    value === 'assigned' ||
    value === 'reported' ||
    value === 'all' ||
    value === 'done'
  ) {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--filter must be assigned, reported, all or done.'
  )
}

export const JIRA_HANDLERS: Record<string, CommandHandler> = {
  ...JIRA_WRITE_HANDLERS,
  'jira connection': async (context) => {
    const response = await context.client.call<JiraConnectionStatus>('jira.status')
    printResult(response, context.json, (status) =>
      [
        ...(status.sites ?? []).map(
          (site) =>
            `${site.id}\t${site.siteUrl}${status.selectedSiteId === site.id ? '\t(selected)' : ''}`
        ),
        ...(status.credentialError ? [status.credentialError] : []),
        'Saved Orca Jira connections; this does not verify access or agent MCP authentication.'
      ].join('\n')
    )
  },
  'jira issue': async (context) => {
    const target = await issueTarget(context)
    const response = await context.client.call<JiraIssue | null>('jira.getIssue', {
      key: target.key,
      siteId: target.siteId,
      strict: true
    })
    const issue = response.result
    const parsed = parseJiraIssueUrl(issue?.url ?? '')
    if (
      !issue ||
      !parsed ||
      !isResolvedJiraIssueMatch(parsed, target.site, issue) ||
      issue.key.toUpperCase() !== target.key
    ) {
      throw new RuntimeClientError(
        'jira_issue_unavailable',
        'Jira did not return the requested issue on the selected site.'
      )
    }
    printResult({ ...response, result: issue }, context.json, formatJiraIssue)
  },
  'jira list': async (context) => {
    const filter = parseFilter(context)
    const limit = getOptionalPositiveIntegerFlag(context.flags, 'limit')
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraIssue[]>('jira.listIssues', {
      filter,
      limit,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraIssueList)
  },
  'jira search': async (context) => {
    const jql = getRequiredStringFlag(context.flags, 'jql').trim()
    const limit = getOptionalPositiveIntegerFlag(context.flags, 'limit')
    if (!jql) {
      throw new RuntimeClientError('invalid_argument', 'JQL cannot be blank.')
    }
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraIssue[]>('jira.searchIssues', {
      jql,
      limit,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraIssueList)
  },
  'jira project list': async (context) => {
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraProject[]>('jira.listProjects', {
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraProjectList)
  },
  'jira project types': async (context) => {
    const projectIdOrKey = getRequiredStringFlag(context.flags, 'project')
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraIssueType[]>('jira.listIssueTypes', {
      projectIdOrKey,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraIssueTypeList)
  },
  'jira project fields': async (context) => {
    const projectIdOrKey = getRequiredStringFlag(context.flags, 'project')
    const issueTypeId = getRequiredStringFlag(context.flags, 'type')
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraCreateField[]>('jira.listCreateFields', {
      projectIdOrKey,
      issueTypeId,
      siteId: target.siteId,
      strict: true
    })
    printResult(
      response,
      context.json,
      (fields) =>
        fields
          .map(
            (field) => `${field.key}\t${field.name}\t${field.required ? 'required' : 'optional'}`
          )
          .join('\n') || 'No create fields.'
    )
  },
  'jira comment list': async (context) => {
    const target = await issueTarget(context)
    const response = await context.client.call<JiraComment[]>('jira.issueComments', {
      key: target.key,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraCommentList)
  },
  'jira status list': async (context) => {
    const target = await issueTarget(context)
    const response = await context.client.call<JiraTransition[]>('jira.listTransitions', {
      key: target.key,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraTransitionList)
  },
  'jira assignee list': async (context) => {
    const query = getOptionalStringFlag(context.flags, 'query')
    const target = await issueTarget(context)
    const response = await context.client.call<JiraUser[]>('jira.listAssignableUsers', {
      key: target.key,
      query,
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraUserList)
  },
  'jira priority list': async (context) => {
    const target = await resolveJiraTarget(context)
    const response = await context.client.call<JiraPriority[]>('jira.listPriorities', {
      siteId: target.siteId,
      strict: true
    })
    printResult(response, context.json, formatJiraPriorityList)
  }
}
