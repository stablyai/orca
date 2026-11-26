import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  commanderPreferenceResult,
  commanderMemoryList,
  commanderMemoryPage,
  type CommanderMemoryWrite
} from '../../../shared/commander/memory-contract'
import { RuntimeClientError } from '../../runtime/connection/types'

const scopedList = commanderMemoryList.extend({
  actor: z.object({ type: z.literal('commander'), id: z.string() }),
  projectId: z.string()
})

const frozenPlan = z.object({
  binding: z.string().length(64),
  model: z.string().optional(),
  effort: z.string().optional(),
  reason: z.string(),
  guidelines: z.string()
})
type FrozenPlan = z.infer<typeof frozenPlan>
export async function openDispatchMemory(projectId: string) {
  const file = process.env.ORCA_COMMANDER_MEMORY_GRANT_FILE
  const grant = file
    ? z
        .object({
          type: z.literal('commander'),
          url: z.string(),
          token: z.string(),
          projectId: z.literal(projectId),
          expiresAt: z.iso.datetime()
        })
        .parse(JSON.parse(await readFile(file, 'utf8')))
    : undefined
  if (grant && Date.parse(grant.expiresAt) <= Date.now()) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The Commander grant has expired. Export a new one.'
    )
  }
  const rawUrl = grant?.url ?? process.env.ORCA_COMMANDER_MEMORY_URL
  const token = grant?.token ?? process.env.ORCA_COMMANDER_MEMORY_TOKEN
  if (!rawUrl || !token?.startsWith('orcacmd_')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Configure a memory service URL and a delegated Commander token.'
    )
  }
  const url = new URL(rawUrl)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    url.pathname.replace(/\/$/u, '') !== '/v1/commander/memory' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The Commander memory URL must use HTTPS or loopback HTTP.'
    )
  }
  async function request(
    path: string,
    write?:
      | (CommanderMemoryWrite & { replayPlan: FrozenPlan })
      | {
          expectedProjectId: string
          expectedActorType: 'commander'
          requestId: string
          question: string
        }
  ) {
    const response = await fetch(url.href.replace(/\/$/u, '') + path, {
      method: write ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      body: write ? JSON.stringify(write) : undefined
    })
    if (response.status === 404 && path.startsWith('/dispatch-plans/')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'No frozen Commander plan exists for this request and credential. Inspect the original runtime with orchestration request-show before starting other work.'
      )
    }
    if (!response.ok) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Commander memory returned HTTP ${response.status}.`
      )
    }
    return response.json()
  }
  return {
    async askPreference(question: string, requestId: string) {
      // The service checks the credential against the expected project before matching or writing.
      return commanderPreferenceResult.parse(
        await request('/preferences/ask', {
          expectedProjectId: projectId,
          expectedActorType: 'commander',
          requestId,
          question
        })
      )
    },
    async list() {
      const result = scopedList.parse(await request(''))
      if (result.projectId !== projectId) {
        throw new RuntimeClientError(
          'invalid_argument',
          'The delegated Commander credential belongs to another project.'
        )
      }
      return result.pages
    },
    async replay(requestId: string, binding: string) {
      const original = z
        .object({
          projectId: z.literal(projectId),
          pageId: z.literal(`dispatch-${requestId}`),
          plan: frozenPlan
        })
        .parse(await request(`/dispatch-plans/${requestId}`))
      if (original.plan.binding !== binding) {
        throw new RuntimeClientError(
          'invalid_argument',
          'This retry does not match the original Commander launch or runtime.'
        )
      }
      return { ...original.plan, projectId, pageId: original.pageId, requestId }
    },
    async write(write: CommanderMemoryWrite, replayPlan: FrozenPlan) {
      return commanderMemoryPage
        .extend({ planSaved: z.literal(true) })
        .parse(await request('/commander', { ...write, replayPlan })).page
    }
  }
}
