import type { CommandHandler } from '../dispatch'

function str(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function id(flags: Map<string, string | boolean>): string {
  const value = str(flags, 'id')
  if (!value) {
    throw new Error('Plane work item ID is required')
  }
  return value
}

function projectId(flags: Map<string, string | boolean>): string {
  const value = str(flags, 'project')
  if (!value) {
    throw new Error('Plane project ID is required')
  }
  return value
}

function estimateValue(flags: Map<string, string | boolean>): string | number | undefined {
  const value = str(flags, 'estimate')
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

async function output(json: boolean, value: unknown): Promise<void> {
  console.log(json ? JSON.stringify(value, null, 2) : formatPlain(value))
}

function formatPlain(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatPlain(item)).join('\n')
  }
  if (!value || typeof value !== 'object') {
    return String(value ?? '')
  }
  const raw = value as Record<string, unknown>
  return [raw.identifier ?? raw.name ?? raw.id, raw.title ?? raw.baseUrl ?? '', raw.url ?? '']
    .filter(Boolean)
    .join(' · ')
}

export const PLANE_HANDLERS: Record<string, CommandHandler> = {
  'plane status': async ({ client, json }) => output(json, await client.call('plane.status')),
  'plane connect': async ({ flags, client, json }) => {
    const result = await client.call('plane.connect', {
      baseUrl: str(flags, 'base-url'),
      workspaceSlug: str(flags, 'workspace'),
      apiKey: str(flags, 'api-key')
    })
    await output(json, result)
  },
  'plane project list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listProjects', { instanceId: str(flags, 'instance') })),
  'plane cycle list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listCycles', { projectId: projectId(flags), instanceId: str(flags, 'instance') })),
  'plane module list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listModules', { projectId: projectId(flags), instanceId: str(flags, 'instance') })),
  'plane type list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listWorkItemTypes', { projectId: projectId(flags), instanceId: str(flags, 'instance') })),
  'plane estimate list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listEstimates', { projectId: projectId(flags), instanceId: str(flags, 'instance') })),
  'plane issue': async ({ flags, client, json }) => {
    const issue = await client.call('plane.getIssue', { id: id(flags), instanceId: str(flags, 'instance') })
    const comments = flags.get('comments') === true && issue
      ? await client.call('plane.issueComments', { id: id(flags), instanceId: str(flags, 'instance') })
      : undefined
    await output(json, comments ? { issue, comments } : issue)
  },
  'plane search': async ({ flags, client, json }) =>
    output(json, await client.call('plane.searchIssues', { query: str(flags, 'query'), limit: numberFlag(flags, 'limit'), instanceId: str(flags, 'instance') })),
  'plane list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.listIssues', { filter: str(flags, 'filter'), limit: numberFlag(flags, 'limit'), instanceId: str(flags, 'instance') })),
  'plane status set': async ({ flags, client, json }) =>
    output(json, await client.call('plane.updateIssue', { id: id(flags), instanceId: str(flags, 'instance'), updates: { stateId: str(flags, 'to') } })),
  'plane delete': async ({ flags, client, json }) =>
    output(json, await client.call('plane.deleteIssue', { id: id(flags), instanceId: str(flags, 'instance') })),
  'plane comment add': async ({ flags, client, json }) =>
    output(json, await client.call('plane.addIssueComment', { id: id(flags), instanceId: str(flags, 'instance'), body: str(flags, 'body') })),
  'plane link list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.issueLinks', { id: id(flags), instanceId: str(flags, 'instance') })),
  'plane link add': async ({ flags, client, json }) =>
    output(json, await client.call('plane.addIssueLink', { id: id(flags), title: str(flags, 'title'), url: str(flags, 'url'), instanceId: str(flags, 'instance') })),
  'plane attachment list': async ({ flags, client, json }) =>
    output(json, await client.call('plane.issueAttachments', { id: id(flags), instanceId: str(flags, 'instance') })),
  'plane create': async ({ flags, client, json }) =>
    output(json, await client.call('plane.createIssue', { projectId: str(flags, 'project'), title: str(flags, 'title'), description: str(flags, 'body'), stateId: str(flags, 'state'), priority: str(flags, 'priority'), cycleId: str(flags, 'cycle'), moduleId: str(flags, 'module'), typeId: str(flags, 'type'), estimatePoint: estimateValue(flags), externalSource: str(flags, 'external-source'), externalId: str(flags, 'external-id'), instanceId: str(flags, 'instance') }))
}

function numberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = str(flags, name)
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
