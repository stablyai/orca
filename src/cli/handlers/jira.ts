import type {
  JiraComment,
  JiraCreateIssueResult,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraTransition,
  JiraUser
} from '../../shared/jira-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import {
  formatJiraCommentList,
  formatJiraCreate,
  formatJiraIssue,
  formatJiraIssueList,
  formatJiraIssueTypeList,
  formatJiraPriorityList,
  formatJiraProjectList,
  formatJiraTransitionList,
  formatJiraUserList
} from '../jira-format'
import { RuntimeClientError } from '../runtime-client'

const JIRA_FILTERS = ['assigned', 'reported', 'all', 'done'] as const

type JiraUpdates = {
  labels?: string[]
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
}

function siteId(flags: HandlerContext['flags']): string | undefined {
  return getOptionalStringFlag(flags, 'site')
}

function issueKey(flags: HandlerContext['flags']): string {
  return getRequiredStringFlag(flags, 'key')
}

function parseFilter(flags: HandlerContext['flags']): JiraIssueFilter | undefined {
  const value = getOptionalStringFlag(flags, 'filter')
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (!(JIRA_FILTERS as readonly string[]).includes(normalized)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--filter must be one of ${JIRA_FILTERS.join(', ')}`
    )
  }
  return normalized as JiraIssueFilter
}

// Why: Jira rejects an update whose transition id is unknown, so resolving a
// human-supplied state name against the issue's own transitions keeps
// `--to "In Review"` usable without the agent first listing ids.
async function resolveTransitionId(ctx: HandlerContext, key: string): Promise<string> {
  const explicit = getOptionalStringFlag(ctx.flags, 'to-id')
  if (explicit) {
    return explicit
  }
  const wanted = getOptionalStringFlag(ctx.flags, 'to')
  if (!wanted) {
    throw new RuntimeClientError('invalid_argument', 'Pass --to <name> or --to-id <transitionId>.')
  }
  const response = await ctx.client.call<JiraTransition[]>('jira.listTransitions', {
    key,
    siteId: siteId(ctx.flags)
  })
  const target = wanted.trim().toLowerCase()
  const matches = response.result.filter(
    (transition) =>
      transition.name.toLowerCase() === target || transition.to.name.toLowerCase() === target
  )
  if (matches.length === 0) {
    const available = response.result.map((transition) => transition.name).join(', ')
    throw new RuntimeClientError(
      'invalid_argument',
      `No transition matching "${wanted}". Available: ${available || 'none'}`
    )
  }
  // Why: one transition's name can equal another's destination status, so a
  // silent first-match would move the issue somewhere the caller did not name.
  // Refuse and hand back the ids so `--to-id` can disambiguate.
  if (matches.length > 1) {
    const candidates = matches
      .map((transition) => `${transition.id} (${transition.name} → ${transition.to.name})`)
      .join(', ')
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous transition "${wanted}". Retry with --to-id: ${candidates}`
    )
  }
  return matches[0].id
}

async function applyUpdate(ctx: HandlerContext, updates: JiraUpdates): Promise<void> {
  const key = issueKey(ctx.flags)
  const response = await ctx.client.call<JiraMutationResult>('jira.updateIssue', {
    key,
    siteId: siteId(ctx.flags),
    updates
  })
  if (!response.result.ok) {
    throw new RuntimeClientError('invalid_argument', response.result.error)
  }
  printResult(response, ctx.json, () => `Updated ${key}`)
}

export const JIRA_HANDLERS: Record<string, CommandHandler> = {
  'jira issue': async (ctx) => {
    const response = await ctx.client.call<JiraIssue>('jira.getIssue', {
      key: issueKey(ctx.flags),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraIssue)
  },
  'jira list': async (ctx) => {
    const response = await ctx.client.call<JiraIssue[]>('jira.listIssues', {
      filter: parseFilter(ctx.flags),
      limit: getOptionalPositiveIntegerFlag(ctx.flags, 'limit'),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraIssueList)
  },
  'jira search': async (ctx) => {
    const response = await ctx.client.call<JiraIssue[]>('jira.searchIssues', {
      jql: getRequiredStringFlag(ctx.flags, 'jql'),
      limit: getOptionalPositiveIntegerFlag(ctx.flags, 'limit'),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraIssueList)
  },
  'jira create': async (ctx) => {
    const response = await ctx.client.call<JiraCreateIssueResult>('jira.createIssue', {
      siteId: siteId(ctx.flags),
      projectId: getRequiredStringFlag(ctx.flags, 'project'),
      issueTypeId: getRequiredStringFlag(ctx.flags, 'type'),
      title: getRequiredStringFlag(ctx.flags, 'title'),
      description: getOptionalStringFlag(ctx.flags, 'description')
    })
    const created = response.result
    if (!created.ok) {
      throw new RuntimeClientError('invalid_argument', created.error)
    }
    printResult({ ...response, result: created }, ctx.json, formatJiraCreate)
  },
  'jira project list': async (ctx) => {
    const response = await ctx.client.call<JiraProject[]>('jira.listProjects', {
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraProjectList)
  },
  'jira project types': async (ctx) => {
    const response = await ctx.client.call<JiraIssueType[]>('jira.listIssueTypes', {
      projectIdOrKey: getRequiredStringFlag(ctx.flags, 'project'),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraIssueTypeList)
  },
  'jira comment list': async (ctx) => {
    const response = await ctx.client.call<JiraComment[]>('jira.issueComments', {
      key: issueKey(ctx.flags),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraCommentList)
  },
  'jira comment add': async (ctx) => {
    const key = issueKey(ctx.flags)
    const response = await ctx.client.call<JiraMutationResult>('jira.addIssueComment', {
      key,
      body: getRequiredStringFlag(ctx.flags, 'body'),
      siteId: siteId(ctx.flags)
    })
    if (!response.result.ok) {
      throw new RuntimeClientError('invalid_argument', response.result.error)
    }
    printResult(response, ctx.json, () => `Commented on ${key}`)
  },
  'jira status list': async (ctx) => {
    const response = await ctx.client.call<JiraTransition[]>('jira.listTransitions', {
      key: issueKey(ctx.flags),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraTransitionList)
  },
  'jira status set': async (ctx) => {
    const transitionId = await resolveTransitionId(ctx, issueKey(ctx.flags))
    await applyUpdate(ctx, { transitionId })
  },
  'jira assignee list': async (ctx) => {
    const response = await ctx.client.call<JiraUser[]>('jira.listAssignableUsers', {
      key: issueKey(ctx.flags),
      query: getOptionalStringFlag(ctx.flags, 'query'),
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraUserList)
  },
  'jira assignee set': async (ctx) => {
    await applyUpdate(ctx, { assigneeAccountId: getRequiredStringFlag(ctx.flags, 'to-id') })
  },
  'jira assignee clear': async (ctx) => {
    await applyUpdate(ctx, { assigneeAccountId: null })
  },
  'jira priority list': async (ctx) => {
    const response = await ctx.client.call<JiraPriority[]>('jira.listPriorities', {
      siteId: siteId(ctx.flags)
    })
    printResult(response, ctx.json, formatJiraPriorityList)
  },
  'jira priority set': async (ctx) => {
    await applyUpdate(ctx, { priorityId: getRequiredStringFlag(ctx.flags, 'to-id') })
  },
  'jira priority clear': async (ctx) => {
    await applyUpdate(ctx, { priorityId: null })
  },
  'jira label set': async (ctx) => {
    const labels = getRepeatedStringFlag(ctx.flags, 'label')
    // Why: label set replaces the whole set, so an omitted --label would
    // silently strip every label rather than update nothing.
    if (labels.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--label is required; pass every label the issue should keep.'
      )
    }
    await applyUpdate(ctx, { labels })
  }
}
