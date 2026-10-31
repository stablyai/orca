import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  command,
  record,
  text,
  type Command
} from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

type Role = 'mobile' | 'cloud'
export function createOwnerBridge() {
  const queues: Record<Role, Command[]> = { mobile: [], cloud: [] }
  const polls = new Map<Role, ServerResponse>()
  const requests = new Map<
    string,
    { role: Role; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const ready = { mobile: Promise.withResolvers<void>(), cloud: Promise.withResolvers<void>() }
  const events = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  let route: (path: string, body: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('Bridge actor missing')
  }
  let failure: Error | undefined
  const roleOf = (value: unknown): Role => {
    if (value !== 'mobile' && value !== 'cloud') {
      throw new Error('Unexpected integration role')
    }
    return value
  }
  const reply = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/next') {
        const role = roleOf(url.searchParams.get('role'))
        if (polls.has(role)) {
          throw new Error('Duplicate actor poll')
        }
        const queued = queues[role].shift()
        if (queued) {
          reply(response, queued)
        } else {
          polls.set(role, response)
        }
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 1024 * 1024) {
          throw new Error('Integration envelope too large')
        }
        chunks.push(buffer)
      }
      const value = record(JSON.parse(Buffer.concat(chunks).toString()))
      if (url.pathname === '/ready') {
        ready[roleOf(value.role)].resolve()
      } else if (url.pathname === '/result') {
        const id = text(value.id)
        const pending = requests.get(id)
        if (!pending || pending.role !== roleOf(value.role)) {
          throw new Error('Unowned actor result')
        }
        requests.delete(id)
        if (value.ok === true) {
          pending.resolve(value.data)
        } else {
          pending.reject(new Error(text(value.data)))
        }
      } else if (url.pathname === '/event') {
        handle.event(text(value.name), value.data)
      } else {
        reply(response, await route(url.pathname, value))
        return
      }
      reply(response, null)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      response.writeHead(500)
      response.end(String(error))
      for (const pending of requests.values()) {
        pending.reject(failure)
      }
    }
  })
  const handle = {
    async start() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No owned bridge address')
      }
      return `http://127.0.0.1:${address.port}`
    },
    route(value: typeof route) {
      route = value
    },
    ready(role: Role) {
      return ready[role].promise
    },
    call(role: Role, op: string, data: Record<string, unknown> = {}): Promise<unknown> {
      if (failure) {
        return Promise.reject(failure)
      }
      const id = randomUUID()
      const payload = command({ id, op, data })
      const pending = Promise.withResolvers<unknown>()
      requests.set(id, { role, ...pending })
      const poll = polls.get(role)
      if (poll) {
        polls.delete(role)
        reply(poll, payload)
      } else {
        queues[role].push(payload)
      }
      return pending.promise
    },
    event(name: string, value: unknown = null) {
      let event = events.get(name)
      if (!event) {
        event = Promise.withResolvers<unknown>()
        events.set(name, event)
      }
      event.resolve(value)
    },
    wait(name: string) {
      let event = events.get(name)
      if (!event) {
        event = Promise.withResolvers<unknown>()
        events.set(name, event)
      }
      return event.promise
    },
    async close() {
      const unclosed = requests.size + queues.mobile.length + queues.cloud.length
      for (const poll of polls.values()) {
        poll.end()
      }
      polls.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      if (failure) {
        throw failure
      }
      if (unclosed) {
        throw new Error(`Unsettled integration messages: ${unclosed}`)
      }
    }
  }
  return handle
}
export function integrationRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Missing actual DB/provider rows')
  }
  return value.map(record)
}
export async function integrationDeadline<T>(
  promise: Promise<T>,
  label: string,
  ms = 20_000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Integration boundary timed out: ${label}`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export { ownerCleanup } from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'
