import { z } from 'zod'
import type {
  JiraCreateIssueResult,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraProject,
  JiraTransition
} from '../../shared/jira/jira-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { readCommandBody } from '../command-body-input'
import {
  getOptionalJsonFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { formatJiraCreate } from '../jira-format'
import { resolveJiraTarget } from '../jira-target'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

async function callJiraWrite<T>(
  context: HandlerContext,
  method: string,
  params: unknown
): Promise<RuntimeRpcSuccess<T>> {
  try {
    return await context.client.call<T>(method, params)
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      [
        'runtime_timeout',
        'runtime_connection_failed',
        'runtime_disconnected',
        'runtime_unavailable'
      ].includes(error.code)
    ) {
      throw new RuntimeClientError(
        'jira_write_unverified',
        `${error.message} The Jira change may have been applied. Verify in Jira before retrying.`
      )
    }
    throw error
  }
}

async function applyUpdate(context: HandlerContext, updates: JiraIssueUpdate): Promise<void> {
  if (updates.assigneeAccountId === '' || updates.priorityId === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--to-id cannot be blank. Use the clear command to clear a field.'
    )
  }
  const target = await resolveJiraTarget(context, getRequiredStringFlag(context.flags, 'key'))
  const response = await callJiraWrite<JiraMutationResult>(context, 'jira.updateIssue', {
    key: target.key,
    siteId: target.siteId,
    updates
  })
  if (!response.result.ok) {
    throw new RuntimeClientError(
      'jira_write_failed',
      `${response.result.error} Jira did not confirm the change. Verify in Jira before retrying.`
    )
  }
  printResult(
    { ...response, result: { ...response.result, key: target.key, siteId: target.siteId } },
    context.json,
    () => `Updated ${target.key} (${target.siteId})`
  )
}

function requiredLabels(context: HandlerContext): string[] {
  const labels = [
    ...new Set(getRepeatedStringFlag(context.flags, 'label').map((value) => value.trim()))
  ]
  if (!labels.length || labels.some((label) => !label || /\s/.test(label))) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--label is required and each label must be nonempty without whitespace.'
    )
  }
  return labels
}

async function transition(context: HandlerContext): Promise<void> {
  const wanted = getOptionalStringFlag(context.flags, 'to')?.trim()
  const explicit = getOptionalStringFlag(context.flags, 'to-id')?.trim()
  if (Boolean(wanted) === Boolean(explicit)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --to <name> or --to-id <transitionId>.'
    )
  }
  const target = await resolveJiraTarget(context, getRequiredStringFlag(context.flags, 'key'))
  const { result: transitions } = await context.client.call<JiraTransition[]>(
    'jira.listTransitions',
    { key: target.key, siteId: target.siteId, strict: true }
  )
  const matches = transitions.filter((entry) =>
    explicit
      ? entry.id === explicit
      : entry.name.toLowerCase() === wanted?.toLowerCase() ||
        entry.to.name.toLowerCase() === wanted?.toLowerCase()
  )
  if (matches.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Expected one available transition. Choose --to-id from: ${transitions.map((entry) => `${entry.id} (${entry.name} → ${entry.to.name})`).join(', ') || 'none'}`
    )
  }
  const response = await callJiraWrite<JiraMutationResult>(context, 'jira.updateIssue', {
    key: target.key,
    siteId: target.siteId,
    updates: { transitionId: matches[0].id }
  })
  if (!response.result.ok) {
    throw new RuntimeClientError(
      'jira_write_failed',
      `${response.result.error} Jira did not confirm the change. Verify in Jira before retrying.`
    )
  }
  printResult(response, context.json, () => `Transitioned ${target.key} (${target.siteId})`)
}

async function readJiraBody(
  context: HandlerContext,
  required: boolean
): Promise<string | undefined> {
  const body = await readCommandBody(context.flags, context.cwd, {
    required,
    maximumCharacters: 100_000,
    tooLargeCode: 'jira_body_too_large',
    label: 'Jira body'
  })
  if (required && !body?.trim()) {
    throw new RuntimeClientError('invalid_argument', 'Comment body cannot be blank.')
  }
  return body
}

async function create(context: HandlerContext): Promise<void> {
  const projectInput = getRequiredStringFlag(context.flags, 'project').trim()
  const issueTypeId = getRequiredStringFlag(context.flags, 'type').trim()
  const title = getRequiredStringFlag(context.flags, 'title').trim()
  if (!projectInput || !issueTypeId || !title) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Project, issue type and title cannot be blank.'
    )
  }
  const description = await readJiraBody(context, false)
  const fieldsJson = getOptionalJsonFlag(context.flags, 'fields-json')
  let customFields: Record<string, unknown> | undefined
  if (fieldsJson !== undefined) {
    try {
      customFields = z.record(z.string(), z.unknown()).parse(JSON.parse(fieldsJson))
    } catch {
      throw new RuntimeClientError('invalid_argument', '--fields-json must be a JSON object.')
    }
    const fields = customFields
    if (['project', 'issuetype', 'summary', 'description'].some((key) => key in fields)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use the project, type, title and body flags for standard fields.'
      )
    }
  }
  const userFieldKeys = getRepeatedStringFlag(context.flags, 'user-field')
  const target = await resolveJiraTarget(context)
  const { result: projects } = await context.client.call<JiraProject[]>('jira.listProjects', {
    siteId: target.siteId,
    strict: true
  })
  const matches = projects.filter(
    (project) =>
      project.id === projectInput || project.key.toLowerCase() === projectInput.toLowerCase()
  )
  if (matches.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Project did not match exactly one project on this Jira site. Use orca jira project list.'
    )
  }
  const response = await callJiraWrite<JiraCreateIssueResult>(context, 'jira.createIssue', {
    siteId: target.siteId,
    projectId: matches[0].id,
    issueTypeId,
    title,
    description,
    customFields,
    userFieldKeys
  })
  if (!response.result.ok) {
    throw new RuntimeClientError(
      'jira_write_failed',
      `${response.result.error} Jira did not confirm the change. Verify in Jira before retrying.`
    )
  }
  printResult({ ...response, result: response.result }, context.json, formatJiraCreate)
}

export const JIRA_WRITE_HANDLERS: Record<string, CommandHandler> = {
  'jira create': create,
  'jira comment add': async (context) => {
    const body = await readJiraBody(context, true)
    const target = await resolveJiraTarget(context, getRequiredStringFlag(context.flags, 'key'))
    const response = await callJiraWrite<JiraMutationResult & { id?: string }>(
      context,
      'jira.addIssueComment',
      { key: target.key, body, siteId: target.siteId }
    )
    if (!response.result.ok) {
      throw new RuntimeClientError(
        'jira_write_failed',
        `${response.result.error} Jira did not confirm the change. Verify in Jira before retrying.`
      )
    }
    printResult(response, context.json, () => `Commented on ${target.key} (${target.siteId})`)
  },
  'jira status set': transition,
  'jira assignee set': (context) =>
    applyUpdate(context, {
      assigneeAccountId: getRequiredStringFlag(context.flags, 'to-id').trim()
    }),
  'jira assignee clear': (context) => applyUpdate(context, { assigneeAccountId: null }),
  'jira priority set': (context) =>
    applyUpdate(context, { priorityId: getRequiredStringFlag(context.flags, 'to-id').trim() }),
  'jira priority clear': (context) => applyUpdate(context, { priorityId: null }),
  'jira label set': (context) => applyUpdate(context, { labels: requiredLabels(context) }),
  'jira label add': (context) =>
    applyUpdate(context, { labelOperations: { add: requiredLabels(context) } }),
  'jira label rm': (context) =>
    applyUpdate(context, { labelOperations: { remove: requiredLabels(context) } })
}
