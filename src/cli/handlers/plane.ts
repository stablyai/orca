import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  PlaneComment,
  PlaneConnectionStatus,
  PlaneIssue,
  PlanePriority,
  PlaneProject,
  PlaneState
} from '../../shared/plane-types'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { printResult } from '../format'
import {
  formatPlaneCommentAdd,
  formatPlaneCreate,
  formatPlaneIssue,
  formatPlaneIssueList,
  formatPlanePrioritySet,
  formatPlaneProjectList,
  formatPlaneStateList,
  formatPlaneStatus,
  formatPlaneStatusSet,
  formatPlaneWorkspaceList
} from '../plane-format'
import { RuntimeClientError } from '../runtime-client'

const VALID_PRIORITIES = new Set(['none', 'urgent', 'high', 'medium', 'low'])

function getPlanePriority(flags: Map<string, string | boolean>, name: string): PlanePriority {
  const value = getRequiredStringFlag(flags, name).toLowerCase()
  if (!VALID_PRIORITIES.has(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid priority: ${value}. Allowed: none, urgent, high, medium, low`
    )
  }
  return value as PlanePriority
}

async function readPlaneBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: boolean }
): Promise<string | undefined> {
  const hasBody = flags.has('body')
  const hasBodyFile = flags.has('body-file')
  if (hasBody && hasBodyFile) {
    throw new RuntimeClientError('invalid_argument', 'Use either --body or --body-file, not both')
  }
  if (!hasBody && !hasBodyFile) {
    if (options.required) {
      throw new RuntimeClientError('invalid_argument', 'Missing --body or --body-file')
    }
    return undefined
  }
  if (hasBody) {
    return getRequiredStringFlagAllowingEmpty(flags, 'body')
  }
  const file = getRequiredStringFlag(flags, 'body-file')
  if (file !== '-') {
    return await readFile(isAbsolute(file) ? file : join(cwd, file), 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const PLANE_HANDLERS: Record<string, CommandHandler> = {
  'plane status': async ({ client, json }) => {
    const response = await client.call<PlaneConnectionStatus>('plane.status')
    printResult(response, json, formatPlaneStatus)
  },

  'plane connect': async ({ flags, client, json }) => {
    const apiKey = getRequiredStringFlag(flags, 'token')
    const baseUrl = getOptionalStringFlag(flags, 'base-url')
    const authType = getOptionalStringFlag(flags, 'auth-type') as 'cloud' | 'self-hosted' | undefined
    const response = await client.call<{ ok: boolean; error?: string; viewer?: unknown }>(
      'plane.connect',
      {
        apiKey,
        baseUrl,
        authType
      }
    )
    printResult(response, json, (res) =>
      res.ok ? 'Connected to Plane successfully.' : `Failed to connect: ${res.error}`
    )
  },

  'plane disconnect': async ({ client, json }) => {
    const response = await client.call<PlaneConnectionStatus>('plane.disconnect')
    printResult(response, json, formatPlaneStatus)
  },

  'plane workspace list': async ({ client, json }) => {
    const response = await client.call<PlaneConnectionStatus>('plane.status')
    printResult(response, json, formatPlaneWorkspaceList)
  },

  'plane workspace select': async ({ flags, client, json }) => {
    const slug = getRequiredStringFlag(flags, 'slug')
    const response = await client.call<{ ok: boolean; selectedSlug: string }>(
      'plane.selectWorkspace',
      { slug }
    )
    printResult(response, json, (res) =>
      res.ok ? `Selected Plane workspace "${res.selectedSlug}".` : 'Failed to select workspace.'
    )
  },

  'plane project list': async ({ flags, client, json }) => {
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')
    const response = await client.call<PlaneProject[]>('plane.listProjects', {
      workspaceSlug
    })
    printResult(response, json, formatPlaneProjectList)
  },

  'plane state list': async ({ flags, client, json }) => {
    const projectId = getRequiredStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')
    const response = await client.call<PlaneState[]>('plane.listStates', {
      projectId,
      workspaceSlug
    })
    printResult(response, json, formatPlaneStateList)
  },

  'plane list': async ({ flags, client, json }) => {
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const response = await client.call<PlaneIssue[]>('plane.listIssues', {
      projectId,
      workspaceSlug,
      limit
    })
    printResult(response, json, formatPlaneIssueList)
  },

  'plane issue': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')
    const includeComments = flags.get('comments') === true
    const response = await client.call<{ issue: PlaneIssue; comments?: PlaneComment[] }>(
      'plane.getIssue',
      {
        id,
        projectId,
        workspaceSlug,
        includeComments
      }
    )
    printResult(response, json, formatPlaneIssue)
  },

  'plane create': async ({ flags, client, cwd, json }) => {
    const title = getRequiredStringFlag(flags, 'title')
    const projectId = getRequiredStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')
    const stateId = getOptionalStringFlag(flags, 'state')
    const priority = flags.has('priority') ? getPlanePriority(flags, 'priority') : undefined
    const description = await readPlaneBody(flags, cwd, { required: false })

    const response = await client.call<PlaneIssue>('plane.createIssue', {
      title,
      projectId,
      workspaceSlug,
      stateId,
      priority,
      description
    })
    printResult(response, json, formatPlaneCreate)
  },

  'plane status set': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const to = getRequiredStringFlag(flags, 'to')
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')

    const response = await client.call<{ issueId: string; state: PlaneState }>(
      'plane.issueSetState',
      {
        id,
        to,
        projectId,
        workspaceSlug
      }
    )
    printResult(response, json, formatPlaneStatusSet)
  },

  'plane priority set': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const priority = getPlanePriority(flags, 'to')
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')

    const response = await client.call<{ issueId: string; priority: string }>(
      'plane.issueSetPriority',
      {
        id,
        priority,
        projectId,
        workspaceSlug
      }
    )
    printResult(response, json, formatPlanePrioritySet)
  },

  'plane priority clear': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')

    const response = await client.call<{ issueId: string; priority: string }>(
      'plane.issueSetPriority',
      {
        id,
        priority: 'none',
        projectId,
        workspaceSlug
      }
    )
    printResult(response, json, formatPlanePrioritySet)
  },

  'plane comment add': async ({ flags, client, cwd, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const body = await readPlaneBody(flags, cwd, { required: true })
    const projectId = getOptionalStringFlag(flags, 'project')
    const workspaceSlug = getOptionalStringFlag(flags, 'workspace')

    const response = await client.call<{ ok: boolean; issueId: string }>(
      'plane.issueAddComment',
      {
        id,
        body,
        projectId,
        workspaceSlug
      }
    )
    printResult(response, json, formatPlaneCommentAdd)
  }
}
