import type {
  PaperclipCompany,
  PaperclipConnectArgs,
  PaperclipConnectionIdentity,
  PaperclipConnectionStatus,
  PaperclipConnectionSummary,
  PaperclipIssue,
  PaperclipLaunchAdmission,
  PaperclipLaunchAdmissionRequest,
  PaperclipProject
} from '../../shared/paperclip-types'
import {
  clearPaperclipConnection,
  getPaperclipConnection,
  savePaperclipConnection
} from './paperclip-connection-store'
import { createPaperclipOriginPolicy, type PaperclipOriginPolicy } from './paperclip-origin-policy'
import { PaperclipApiError, paperclipRequest } from './paperclip-request'
import { parsePaperclipIssue } from './paperclip-response'
import {
  decidePaperclipLaunchAdmission,
  reducePaperclipActiveRunResponse
} from './paperclip-launch-admission'
import { createPaperclipConnectionId } from './paperclip-connection-id'

export async function getStatus(): Promise<PaperclipConnectionStatus> {
  const stored = getPaperclipConnection()
  if (!stored) {
    return { connected: false, connection: null }
  }
  const policy = createPaperclipOriginPolicy(stored.origin)
  const companies = parseCompanies(await paperclipRequest({ policy, segments: ['companies'] }))
  const company = companies.find((item) => item.id === stored.companyId)
  if (!company) {
    throw new Error('The bound Paperclip company is unavailable.')
  }
  const projects = parseProjects(
    await paperclipRequest({ policy, segments: ['companies', company.id, 'projects'] }),
    company.id
  )
  const project = projects.find((item) => item.id === stored.projectId)
  if (!project) {
    throw new Error('The bound Paperclip project is unavailable.')
  }
  return {
    connected: true,
    connection: { ...stored, companyName: company.name, projectName: project.name }
  }
}

export async function connect(
  args: PaperclipConnectArgs
): Promise<{ ok: true; connection: PaperclipConnectionSummary } | { ok: false; error: string }> {
  try {
    const policy = createPaperclipOriginPolicy(args.origin)
    const companies = parseCompanies(await paperclipRequest({ policy, segments: ['companies'] }))
    const company = companies.find((item) => item.id === args.companyId)
    if (!company) {
      throw new Error('The selected Paperclip company is unavailable.')
    }
    const projects = parseProjects(
      await paperclipRequest({
        policy,
        segments: ['companies', company.id, 'projects']
      }),
      company.id
    )
    const project = projects.find((item) => item.id === args.projectId)
    if (!project) {
      throw new Error('The selected Paperclip project is unavailable.')
    }
    const connection: PaperclipConnectionSummary = {
      id: createPaperclipConnectionId(policy.origin, company.id, project.id),
      origin: policy.origin,
      companyId: company.id,
      companyName: company.name,
      projectId: project.id,
      projectName: project.name
    }
    savePaperclipConnection({
      id: connection.id,
      origin: connection.origin,
      companyId: connection.companyId,
      projectId: connection.projectId
    })
    return { ok: true, connection }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
}

export function disconnect(): void {
  clearPaperclipConnection()
}

export async function testConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = getClient()
    const projects = parseProjects(
      await paperclipRequest({
        ...client,
        segments: ['companies', client.connection.companyId, 'projects']
      }),
      client.connection.companyId
    )
    if (!projects.some((project) => project.id === client.connection.projectId)) {
      throw new Error('The bound Paperclip project is unavailable.')
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
}

export async function listIssues(query?: string): Promise<PaperclipIssue[]> {
  const client = getClient()
  const value = await paperclipRequest({
    ...client,
    segments: ['companies', client.connection.companyId, 'issues'],
    query: { projectId: client.connection.projectId, q: query?.trim() || undefined }
  })
  if (!Array.isArray(value)) {
    throw new Error('Paperclip returned an invalid issue list.')
  }
  return value.map((issue) =>
    parsePaperclipIssue(issue, {
      companyId: client.connection.companyId,
      projectId: client.connection.projectId
    })
  )
}

export async function getIssue(issueId: string): Promise<PaperclipIssue> {
  const client = getClient()
  return parsePaperclipIssue(await paperclipRequest({ ...client, segments: ['issues', issueId] }), {
    companyId: client.connection.companyId,
    projectId: client.connection.projectId
  })
}

export async function getLaunchAdmission(
  expected: PaperclipLaunchAdmissionRequest
): Promise<PaperclipLaunchAdmission> {
  const client = getClient()
  if (!isPaperclipConnectionMatch(client.connection, expected)) {
    return { allowed: false, reason: 'unknown_run_state' }
  }
  const issue = await getIssue(expected.issueId)
  let activeRun
  try {
    const body = await paperclipRequest({
      ...client,
      segments: ['issues', expected.issueId, 'active-run']
    })
    activeRun = reducePaperclipActiveRunResponse({
      body,
      expectedIssueId: issue.id,
      expectedCompanyId: client.connection.companyId
    })
  } catch (error) {
    activeRun = {
      state: 'unknown' as const,
      reason:
        error instanceof PaperclipApiError && (error.status === 401 || error.status === 403)
          ? ('unauthorized' as const)
          : error instanceof PaperclipApiError && error.status === 404
            ? ('unsupported' as const)
            : ('unavailable' as const)
    }
  }
  return decidePaperclipLaunchAdmission({ activeRun, issue })
}

export function isPaperclipConnectionMatch(
  connection: PaperclipConnectionIdentity,
  expected: PaperclipLaunchAdmissionRequest
): boolean {
  return (
    connection.id === expected.connectionId &&
    connection.companyId === expected.companyId &&
    connection.projectId === expected.projectId
  )
}

function getClient(): {
  connection: PaperclipConnectionIdentity
  policy: PaperclipOriginPolicy
} {
  const connection = getPaperclipConnection()
  if (!connection) {
    throw new Error('Not connected to Paperclip.')
  }
  return {
    connection,
    policy: createPaperclipOriginPolicy(connection.origin)
  }
}

function parseCompanies(value: unknown): PaperclipCompany[] {
  if (!Array.isArray(value)) {
    throw new Error('Paperclip returned an invalid company list.')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Paperclip returned an invalid company.')
    }
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string') {
      throw new Error('Paperclip returned an invalid company.')
    }
    return { id: record.id, name: record.name }
  })
}

function parseProjects(value: unknown, companyId: string): PaperclipProject[] {
  if (!Array.isArray(value)) {
    throw new Error('Paperclip returned an invalid project list.')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Paperclip returned an invalid project.')
    }
    const record = item as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      record.companyId !== companyId
    ) {
      throw new Error('Paperclip project is missing or outside the bound company scope.')
    }
    return { id: record.id, name: record.name, companyId }
  })
}
