import type {
  HulyIssue,
  HulyIssueUpdate,
  HulyComment,
  HulyConnection,
  HulyIssueState,
  HulyListFilter,
  HulyTeamSummary,
  HulyProjectSummary
} from '../../shared/types'
import { runHulyCli } from './huly-cli'
import { withConnection } from './connection-helpers'

type RawHulyIssue = {
  id?: string
  identifier?: string
  title?: string
  description?: string
  url?: string
  state?: Partial<HulyIssueState>
  team?: Partial<HulyTeamSummary>
  project?: Partial<HulyProjectSummary>
  assignee?: { id?: string; displayName?: string; avatarUrl?: string } | null
  labels?: string[]
  labelIds?: string[]
  priority?: number
  dueDate?: string | null
  updatedAt?: string
}

function toIssue(connection: HulyConnection, raw: RawHulyIssue): HulyIssue | null {
  if (!raw.id || !raw.identifier || !raw.title || !raw.url) {
    return null
  }
  return {
    id: raw.id,
    connectionId: connection.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    url: raw.url,
    state: {
      id: raw.state?.id ?? 'unknown',
      name: raw.state?.name ?? 'Unknown',
      type: raw.state?.type ?? 'open',
      color: raw.state?.color
    },
    team: {
      id: raw.team?.id ?? 'unknown',
      name: raw.team?.name ?? 'Unknown',
      key: raw.team?.key ?? ''
    },
    project: raw.project
      ? {
          id: raw.project.id ?? '',
          name: raw.project.name ?? '',
          description: raw.project.description,
          color: raw.project.color,
          url: raw.project.url
        }
      : undefined,
    labels: raw.labels ?? [],
    labelIds: raw.labelIds ?? [],
    assignee: raw.assignee
      ? {
          id: raw.assignee.id ?? '',
          displayName: raw.assignee.displayName ?? '',
          avatarUrl: raw.assignee.avatarUrl
        }
      : undefined,
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
    dueDate: raw.dueDate,
    updatedAt: raw.updatedAt ?? new Date().toISOString()
  }
}

async function withConnectionStrict<T>(
  connectionId: string | null,
  fn: (connection: HulyConnection, secret: string) => Promise<T>
): Promise<T> {
  const { acquire, getConnection, getSecret, release } = await import('./client')
  const connection = getConnection(connectionId)
  if (!connection) {
    throw new Error('No Huly connection is configured.')
  }
  const secret = getSecret(connection.id)
  if (!secret) {
    throw new Error('Huly connection has no stored credentials.')
  }
  await acquire()
  try {
    return await fn(connection, secret)
  } finally {
    release()
  }
}

export async function listIssues(
  filter: HulyListFilter | undefined,
  limit: number,
  connectionId: string | null
): Promise<HulyIssue[]> {
  return withConnection(connectionId, [], async (connection, secret) => {
    const args = ['issue', 'list', '--limit', String(limit)]
    if (filter && filter !== 'all') {
      args.push(`--${filter}`)
    }
    const raw = await runHulyCli<RawHulyIssue[]>(connection, secret, null, args)
    return raw
      .map((item) => toIssue(connection, item))
      .filter((issue): issue is HulyIssue => issue !== null)
  })
}

export async function getIssue(id: string, connectionId: string | null): Promise<HulyIssue | null> {
  return withConnection(connectionId, null, async (connection, secret) => {
    const raw = await runHulyCli<RawHulyIssue>(connection, secret, null, ['issue', 'get', id])
    return toIssue(connection, raw)
  })
}

export async function searchIssues(
  query: string,
  limit: number,
  connectionId: string | null
): Promise<HulyIssue[]> {
  return withConnection(connectionId, [], async (connection, secret) => {
    const raw = await runHulyCli<RawHulyIssue[]>(connection, secret, null, [
      'issue',
      'list',
      '--query',
      query,
      '--limit',
      String(limit)
    ])
    return raw
      .map((item) => toIssue(connection, item))
      .filter((issue): issue is HulyIssue => issue !== null)
  })
}

export type HulyCreateIssueInput = {
  teamId: string
  title: string
  description?: string
  priority?: number
  stateId?: string
  assigneeId?: string | null
  labelIds?: string[]
  projectId?: string | null
}

export async function createIssue(
  input: HulyCreateIssueInput,
  connectionId: string | null
): Promise<{ ok: true; issue: HulyIssue } | { ok: false; error: string }> {
  try {
    return await withConnectionStrict(connectionId, async (connection, secret) => {
      const args = ['issue', 'create', '--team', input.teamId, '--title', input.title]
      if (input.description) {
        args.push('--description', input.description)
      }
      if (input.priority !== undefined) {
        args.push('--priority', String(input.priority))
      }
      if (input.stateId) {
        args.push('--state', input.stateId)
      }
      if (input.assigneeId) {
        args.push('--assignee', input.assigneeId)
      }
      if (input.labelIds) {
        args.push('--labels', input.labelIds.join(','))
      }
      if (input.projectId) {
        args.push('--project', input.projectId)
      }
      const raw = await runHulyCli<RawHulyIssue>(connection, secret, null, args)
      const issue = toIssue(connection, raw)
      if (!issue) {
        throw new Error('Huly returned an invalid issue payload.')
      }
      return { ok: true as const, issue }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Create failed' }
  }
}

export async function updateIssue(
  id: string,
  updates: HulyIssueUpdate,
  connectionId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withConnectionStrict(connectionId, async (connection, secret) => {
      const args = ['issue', 'update', id]
      if (updates.title !== undefined) {
        args.push('--title', updates.title)
      }
      if (updates.description !== undefined) {
        args.push('--description', updates.description)
      }
      if (updates.stateId !== undefined) {
        args.push('--state', updates.stateId)
      }
      if (updates.priority !== undefined) {
        args.push('--priority', String(updates.priority))
      }
      if (updates.assigneeId !== undefined) {
        args.push('--assignee', updates.assigneeId ?? '')
      }
      if (updates.labelIds !== undefined) {
        args.push('--labels', updates.labelIds.join(','))
      }
      await runHulyCli(connection, secret, null, args)
    })
    return { ok: true as const }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Update failed' }
  }
}

export async function addComment(
  issueId: string,
  body: string,
  connectionId: string | null
): Promise<{ ok: true; comment: HulyComment } | { ok: false; error: string }> {
  try {
    return await withConnectionStrict(connectionId, async (connection, secret) => {
      const raw = await runHulyCli<{ id?: string; createdAt?: string; body?: string }>(
        connection,
        secret,
        null,
        ['thread', 'create', '--issue', issueId, '--body', body]
      )
      return {
        ok: true as const,
        comment: {
          id: raw.id ?? `${issueId}-comment-${Date.now()}`,
          body: raw.body ?? body,
          createdAt: raw.createdAt ?? new Date().toISOString()
        }
      }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Comment failed' }
  }
}

export async function listComments(
  issueId: string,
  connectionId: string | null
): Promise<HulyComment[]> {
  return withConnection(connectionId, [], async (connection, secret) => {
    const raw = await runHulyCli<
      {
        id?: string
        body?: string
        createdAt?: string
        user?: { displayName?: string; avatarUrl?: string }
      }[]
    >(connection, secret, null, ['thread', 'list', '--issue', issueId])
    return raw.map((entry, index) => ({
      id: entry.id ?? `${issueId}-comment-${index}`,
      body: entry.body ?? '',
      createdAt: entry.createdAt ?? new Date().toISOString(),
      user: entry.user
        ? {
            displayName: entry.user.displayName ?? '',
            avatarUrl: entry.user.avatarUrl
          }
        : undefined
    }))
  })
}
