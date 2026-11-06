import { z } from 'zod'
import { acknowledgesOpenCodeV1Policy } from './opencode-text-task-policy'
import type { OpenCodeTextTaskInput } from './opencode-text-task-input'
import type { createOpenCodeTextTaskHttp } from './opencode-text-task-http'

const session = z.looseObject({
  id: z.string().min(1),
  parentID: z.string().nullable().optional(),
  directory: z.string().optional(),
  location: z.looseObject({ directory: z.string() }).optional()
})
const page = z.object({
  data: z.array(session),
  cursor: z.object({ next: z.string().optional() })
})

type Http = ReturnType<typeof createOpenCodeTextTaskHttp>

/** Resolve history on its own server; ownership begins only at a native allocation response. */
export async function openCodeTextTaskTarget(input: {
  task: Pick<
    OpenCodeTextTaskInput,
    'sessionId' | 'continue' | 'fork' | 'external' | 'externalDirectory'
  >
  version: 'v1' | 'v2'
  directory: string
  http: Http
  signal: AbortSignal
  prepare: (
    directory: string
  ) => Promise<{ createBody: Record<string, unknown>; policy: Record<string, unknown> }>
  allocated: (id: string, directory: string) => void
}): Promise<{ id: string; directory: string; owned: boolean; policyAcknowledged: boolean }> {
  const v2 = input.version === 'v2'
  const base = v2 ? '/api/session' : '/session'
  let directory = input.task.external ? input.task.externalDirectory : input.directory
  const query = (dir?: string) => (dir ? `?directory=${encodeURIComponent(dir)}` : '')
  const get = (path: string) => input.http.request('GET', path, undefined, input.signal)
  let selected: z.infer<typeof session> | undefined
  if (input.task.sessionId) {
    selected = session.parse(
      await get(`${base}/${encodeURIComponent(input.task.sessionId)}${v2 ? '' : query(directory)}`)
    )
    directory = v2
      ? (selected.location?.directory ?? directory)
      : input.task.external
        ? (input.task.externalDirectory ?? selected.directory ?? directory)
        : directory
  } else {
    if (v2 && (input.task.external || input.task.continue)) {
      const location = z
        .looseObject({ directory: z.string() })
        .parse(
          await get(
            `/api/location${directory ? `?location[directory]=${encodeURIComponent(directory)}` : ''}`
          )
        )
      directory = location.directory
    }
    if (input.task.continue) {
      if (v2) {
        let cursor: string | undefined
        do {
          input.signal.throwIfAborted()
          const params = new URLSearchParams({
            directory: directory!,
            parentID: 'null',
            limit: '100',
            order: 'desc'
          })
          if (cursor) {
            params.set('cursor', cursor)
          }
          const result = page.parse(
            await input.http.requestRaw('GET', `${base}?${params}`, undefined, input.signal)
          )
          selected = result.data.find(
            (item) => item.location?.directory === directory && !item.parentID
          )
          const next = result.cursor.next
          if (!result.data.length || !next || next === cursor) {
            break
          }
          cursor = next
        } while (!selected)
      } else {
        selected = z
          .array(session)
          .parse(await get(`${base}${query(directory)}`))
          .find((item) => !item.parentID)
        directory = input.task.external
          ? (input.task.externalDirectory ?? selected?.directory ?? directory)
          : directory
      }
    }
  }
  if (!directory) {
    directory = z.looseObject({ directory: z.string() }).parse(await get('/path')).directory
  }
  const prepared = await input.prepare(directory)
  if (selected && !input.task.fork) {
    return { id: selected.id, directory, owned: false, policyAcknowledged: false }
  }
  // Do not lose a late allocation ID on local cancellation; cleanup is registered before any await.
  const created = session.parse(
    await input.http.request(
      'POST',
      selected
        ? `${base}/${encodeURIComponent(selected.id)}/fork${v2 ? '' : query(directory)}`
        : `${base}${v2 ? '' : query(directory)}`,
      selected ? {} : { ...prepared.createBody, ...(v2 ? { location: { directory } } : {}) },
      AbortSignal.timeout(10_000)
    )
  )
  directory = created.location?.directory ?? created.directory ?? directory
  input.allocated(created.id, directory)
  input.signal.throwIfAborted()
  let applied: unknown = created
  if (selected) {
    applied = await input.http.request(
      'PATCH',
      `${base}/${encodeURIComponent(created.id)}${v2 ? '' : query(directory)}`,
      prepared.policy,
      input.signal
    )
    if (!v2 && session.parse(applied).id !== created.id) {
      throw new Error('OpenCode returned a different text task session')
    }
  }
  const policyAcknowledged =
    v2 || acknowledgesOpenCodeV1Policy(applied, prepared.policy, !!selected)
  return { id: created.id, directory, owned: true, policyAcknowledged }
}
