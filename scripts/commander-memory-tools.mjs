import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { commanderPreferenceResult } from '../src/shared/commander/memory-contract.ts'
import {
  humanRecurringAnswer,
  recurringQuestionLimit
} from '../src/shared/commander/recurring-answer.ts'
import { readHandoff } from '../src/shared/commander/handoff-content.ts'

const pageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

async function requestMemory(grant, operation, payload, query) {
  const url = new URL(grant.url)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/commander/memory' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  ) {
    throw new Error('Invalid Commander memory grant origin.')
  }
  if (
    grant.type !== 'agent' ||
    !/^orcacmd_[A-Za-z0-9_-]+$/.test(grant.token) ||
    typeof grant.projectId !== 'string' ||
    !grant.projectId ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.now()
  ) {
    throw new Error('Export a current agent grant for this project from Commander Memory.')
  }
  url.pathname += operation
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  let body = payload
  if (operation === '/agent') {
    body = { ...payload, projectId: grant.projectId }
  } else if (operation === '/preferences/ask') {
    if (payload.expectedProjectId !== grant.projectId) {
      throw new Error('The task project does not match this memory grant.')
    }
    body = { ...payload, expectedActorType: 'agent' }
  }
  const response = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`Commander memory request failed (HTTP ${response.status}).`), {
      status: response.status
    })
  }
  return response.json()
}

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export async function registerCommanderMemoryTools(server, grantPath) {
  const { projectId, url, actorId, tenantId, token } = JSON.parse(await readFile(grantPath, 'utf8'))
  async function request(operation, payload, query) {
    const current = JSON.parse(await readFile(grantPath, 'utf8'))
    if (current.projectId !== projectId || current.url !== url || current.actorId !== actorId) {
      throw new Error(
        'The current memory grant does not match this client’s original project, service or agent.'
      )
    }
    if (typeof tenantId === 'string' && /^[a-f0-9]{64}$/.test(tenantId)) {
      if (current.tenantId !== tenantId) {
        throw new Error(
          'Export a grant for the original Orca account and organization, or restart the client to switch.'
        )
      }
    } else if (current.token !== token) {
      throw new Error(
        'The original grant has no verified account and organization. Restart the client with the renewed grant.'
      )
    }
    return requestMemory(current, operation, payload, query)
  }

  server.registerTool(
    'commander_ask_preference',
    {
      description:
        'Ask an exact recurring project question. A matching owner rule returns its saved answer and records a decision. Reuse the request ID for the same question on retries. Ask the owner if automatic answers are off, missing, or conflicting.',
      inputSchema: {
        projectId: z.string().min(1).max(256).describe('Project ID of the current task.'),
        question: z.string().trim().min(1).max(recurringQuestionLimit),
        requestId: pageId
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ projectId, question, requestId }) => {
      const answer = await request('/preferences/ask', {
        expectedProjectId: projectId,
        question,
        requestId
      })
      return result(commanderPreferenceResult.parse(answer))
    }
  )
  server.registerTool(
    'commander_guidelines',
    {
      description:
        'Read current human-authored guidelines for this delegated project, including account-wide guidelines.',
      annotations: { readOnlyHint: true }
    },
    async () => {
      const { pages } = await request('')
      return result(
        pages.filter(
          (page) =>
            !page.deleted &&
            page.kind === 'guideline' &&
            page.actor.type === 'human' &&
            !humanRecurringAnswer(page)
        )
      )
    }
  )
  server.registerTool(
    'commander_recall',
    {
      description:
        'Read this agent’s project wiki and shared account guidance. Supply a page ID for recent revisions, then pass nextBeforeVersion as beforeVersion to read older revisions.',
      inputSchema: {
        pageId: pageId.optional(),
        beforeVersion: z.number().int().positive().optional(),
        query: z.string().max(512).optional(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ pageId: id, beforeVersion, query, offset, limit }) => {
      if (id) {
        return result(await request(`/pages/${id}`, undefined, { beforeVersion }))
      }
      const { pages } = await request('')
      const needle = query?.toLowerCase()
      const matches = pages
        .filter(
          (page) =>
            !page.deleted &&
            (!needle ||
              [page.pageId, page.title, page.body, ...page.links].some((s) =>
                s.toLowerCase().includes(needle)
              ))
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.pageId.localeCompare(b.pageId))
      return result({ pages: matches.slice(offset, offset + limit), total: matches.length })
    }
  )
  server.registerTool(
    'commander_resume_context',
    {
      description:
        'Find saved work in the granted project to resume after a crash or on a new host. Without a page ID, list handoff titles and revisions, newest first. With a page ID, read the goal, progress and next step. Check the local checkout before continuing.',
      inputSchema: {
        pageId: pageId.optional(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(50).default(12)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ pageId: id, offset, limit }) => {
      if (id) {
        const { page } = await request(`/pages/${id}`, undefined, { beforeVersion: 1 })
        const handoff = readHandoff(page)
        if (!handoff) {
          throw new Error('No active Commander handoff at this page.')
        }
        return result({
          pageId: id,
          projectId: page.projectId,
          version: page.version,
          savedAt: page.createdAt,
          savedBy: page.actor,
          ...handoff
        })
      }
      try {
        return result(await request('/agent/handoffs', undefined, { offset, limit }))
      } catch (error) {
        // Older Memory services only expose the full project wiki.
        if (error.status !== 404) {
          throw error
        }
      }
      const { pages } = await request('')
      const matches = pages
        .filter((page) => readHandoff(page))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.pageId.localeCompare(b.pageId))
      return result({
        handoffs: matches
          .slice(offset, offset + limit)
          .map(({ pageId, title, version, createdAt }) => ({
            pageId,
            goal: title,
            version,
            savedAt: createdAt
          })),
        total: matches.length
      })
    }
  )
  server.registerTool(
    'commander_save_memory',
    {
      description:
        'Save a note or decision owned by this agent in the granted project. Use the same request ID when retrying the same write. Pass the latest page version, or zero to create a page.',
      inputSchema: {
        pageId,
        requestId: pageId,
        expectedVersion: z.number().int().nonnegative(),
        kind: z.enum(['decision', 'note']),
        title: z.string().min(1).max(240),
        body: z
          .string()
          .refine(
            (body) => Buffer.byteLength(body, 'utf8') <= 65_536,
            'Memory body must be at most 65,536 UTF-8 bytes.'
          ),
        links: z.array(pageId).max(128).optional()
      }
    },
    async (args) => result(await request('/agent', args))
  )
  server.registerTool(
    'commander_remove_memory',
    {
      description:
        'Remove a note or decision owned by this agent. Revision history remains available.',
      annotations: { destructiveHint: true },
      inputSchema: { pageId, requestId: pageId, expectedVersion: z.number().int().positive() }
    },
    async (args) => result(await request('/agent', { ...args, deleted: true }))
  )
}
