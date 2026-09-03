import type {
  SentryAssignee,
  SentryConnectionStatus,
  SentryEnvironment,
  SentryIssue,
  SentryIssueQuery,
  SentryIssueUpdate,
  SentryMutationResult,
  SentryOrganization,
  SentryPage,
  SentryProject,
  SentryEvent
} from '../../shared/sentry-types'
import { CredentialDecryptionError } from '../integration-credential-file'
import { normalizeSentryBaseUrl, parseSentryPagination, sentryRequest } from './api-client'
import {
  clearSentryCredential,
  readSentryConnectionFile,
  readSentryToken,
  saveSentryCredential
} from './credential-store'
import { mapEvent, mapIssue, mapOrganization, mapProject } from './mappers'

type ConnectResult = { ok: true; status: SentryConnectionStatus } | { ok: false; error: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sentry request failed.'
}

function currentClient(): {
  baseUrl: string
  token: string
  organization: SentryOrganization
  organizations: SentryOrganization[]
} {
  const file = readSentryConnectionFile()
  const token = readSentryToken()
  if (!file || !token) {
    throw new Error('Sentry is not connected.')
  }
  return { ...file, token }
}

export function getSentryStatus(): SentryConnectionStatus {
  const file = readSentryConnectionFile()
  if (!file) {
    return { connected: false, connection: null, organizations: [] }
  }
  try {
    const token = readSentryToken()
    return {
      connected: Boolean(token),
      connection: token ? { baseUrl: file.baseUrl, organization: file.organization } : null,
      organizations: token ? file.organizations : []
    }
  } catch (error) {
    return {
      connected: false,
      connection: null,
      organizations: file.organizations,
      ...(error instanceof CredentialDecryptionError ? { credentialError: error.message } : {})
    }
  }
}

export async function connectSentry(args: {
  baseUrl: string
  token: string
  organizationSlug?: string
}): Promise<ConnectResult> {
  try {
    const baseUrl = normalizeSentryBaseUrl(args.baseUrl)
    const token = args.token.trim()
    if (!token) {
      return { ok: false, error: 'Auth token is required.' }
    }
    const response = await sentryRequest<unknown[]>({
      baseUrl,
      token,
      path: '/api/0/organizations/'
    })
    const organizations = response.value.map(mapOrganization).filter((org) => org.id && org.slug)
    if (!organizations.length) {
      return { ok: false, error: 'This token cannot access a Sentry organization.' }
    }
    const organization =
      organizations.find((org) => org.slug === args.organizationSlug) ?? organizations[0]
    saveSentryCredential(token, { baseUrl, organization }, organizations)
    return { ok: true, status: getSentryStatus() }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function disconnectSentry(): void {
  clearSentryCredential()
}

export function selectSentryOrganization(slug: string): SentryConnectionStatus {
  const client = currentClient()
  const organization = client.organizations.find((entry) => entry.slug === slug)
  if (!organization) {
    return getSentryStatus()
  }
  saveSentryCredential(
    client.token,
    { baseUrl: client.baseUrl, organization },
    client.organizations
  )
  return getSentryStatus()
}

export async function testSentryConnection(): Promise<ConnectResult> {
  try {
    const client = currentClient()
    return connectSentry({
      baseUrl: client.baseUrl,
      token: client.token,
      organizationSlug: client.organization.slug
    })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

async function currentRequest<T>(
  path: string,
  options: { search?: URLSearchParams; init?: RequestInit } = {}
): Promise<{ value: T; headers: Headers }> {
  const client = currentClient()
  return sentryRequest<T>({
    baseUrl: client.baseUrl,
    token: client.token,
    path: `/api/0/organizations/${encodeURIComponent(client.organization.slug)}${path}`,
    ...options
  })
}

async function currentIssueRequest<T>(
  path: string,
  options: { search?: URLSearchParams; init?: RequestInit } = {}
): Promise<{ value: T; headers: Headers }> {
  const client = currentClient()
  return sentryRequest<T>({
    baseUrl: client.baseUrl,
    token: client.token,
    path: `/api/0/issues/${path}`,
    ...options
  })
}

export async function listSentryProjects(): Promise<SentryProject[]> {
  const { value } = await currentRequest<unknown[]>('/projects/')
  return value.map(mapProject).filter((project) => project.id && project.slug)
}

export async function listSentryEnvironments(): Promise<SentryEnvironment[]> {
  const { value } = await currentRequest<unknown[]>('/environments/')
  return value
    .map((entry) => {
      const data = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
      const name = typeof data.name === 'string' ? data.name : ''
      return { id: typeof data.id === 'string' ? data.id : name, name }
    })
    .filter((environment) => environment.name)
}

function mapAssignable(value: unknown, type: 'user' | 'team'): SentryAssignee | null {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const id = typeof data.id === 'string' ? data.id : ''
  if (!id) {
    return null
  }
  const profile =
    data.user && typeof data.user === 'object' ? (data.user as Record<string, unknown>) : data
  const name =
    typeof profile.name === 'string' ? profile.name : typeof data.slug === 'string' ? data.slug : id
  return {
    type,
    id,
    name,
    email: typeof profile.email === 'string' ? profile.email : null
  }
}

export async function listSentryAssignees(): Promise<SentryAssignee[]> {
  const [members, teams] = await Promise.all([
    currentRequest<unknown[]>('/members/'),
    currentRequest<unknown[]>('/teams/')
  ])
  return [
    ...members.value.map((value) => mapAssignable(value, 'user')),
    ...teams.value.map((value) => mapAssignable(value, 'team'))
  ].filter((value): value is SentryAssignee => value !== null)
}

export async function listSentryIssues(
  query: SentryIssueQuery,
  signal?: AbortSignal
): Promise<SentryPage<SentryIssue>> {
  const search = new URLSearchParams()
  search.set('query', query.query ?? 'is:unresolved')
  search.set('statsPeriod', query.statsPeriod ?? '14d')
  search.set('sort', query.sort ?? 'date')
  search.set('limit', String(Math.min(Math.max(1, query.limit ?? 50), 100)))
  for (const project of query.projects ?? []) {
    search.append('project', project)
  }
  for (const environment of query.environments ?? []) {
    search.append('environment', environment)
  }
  if (query.cursor) {
    search.set('cursor', query.cursor)
  }
  const { value, headers } = await currentRequest<unknown[]>('/issues/', {
    search,
    init: { signal }
  })
  return { items: value.map(mapIssue), ...parseSentryPagination(headers) }
}

export async function getSentryIssue(issueId: string): Promise<SentryIssue | null> {
  try {
    const { value } = await currentIssueRequest<unknown>(`${encodeURIComponent(issueId)}/`)
    return mapIssue(value)
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return null
    }
    throw error
  }
}

export async function listSentryEvents(
  issueId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<SentryPage<SentryEvent>> {
  const search = new URLSearchParams({ full: 'true', limit: '50' })
  if (cursor) {
    search.set('cursor', cursor)
  }
  const { value, headers } = await currentIssueRequest<unknown[]>(
    `${encodeURIComponent(issueId)}/events/`,
    { search, init: { signal } }
  )
  return { items: value.map(mapEvent), ...parseSentryPagination(headers) }
}

export async function updateSentryIssue(
  issueId: string,
  updates: SentryIssueUpdate
): Promise<SentryMutationResult> {
  try {
    const body: Record<string, unknown> = { ...updates }
    if (updates.assignedTo === null) {
      body.assignedTo = ''
    }
    const { value } = await currentIssueRequest<unknown>(`${encodeURIComponent(issueId)}/`, {
      init: { method: 'PUT', body: JSON.stringify(body) }
    })
    return { ok: true, issue: mapIssue(value) }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
