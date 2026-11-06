import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { runOpenCodeTextTaskSession } from './opencode-text-task-session'

const servers: ReturnType<typeof createServer>[] = []
const appliedV1Policy = [
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'read', pattern: '*', action: 'allow' },
  { permission: 'grep', pattern: '*', action: 'allow' },
  { permission: 'glob', pattern: '*', action: 'allow' },
  { permission: 'external_directory', pattern: '*', action: 'allow' },
  { permission: 'read', pattern: 'mcp:*', action: 'deny' }
]
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
  )
})

async function fixture(
  handle: (path: string, body: unknown, response: ServerResponse) => void | Promise<void>
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks).toString('utf8')
    await handle(`${request.method} ${request.url}`, body ? JSON.parse(body) : undefined, response)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test address')
  }
  return `http://127.0.0.1:${address.port}`
}

function json(response: ServerResponse, value: unknown) {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

it.each(['commit-message', 'conversation-name'] as const)(
  'keeps selected helpers working best effort without a create policy (%s)',
  async (operation) => {
    const requests = new Map<string, unknown>()
    const url = await fixture((path, body, response) => {
      requests.set(path, body)
      if (path.startsWith('POST /session?')) {
        json(response, { id: 'legacy' })
      } else if (path.startsWith('GET /event?')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
      } else if (path.startsWith('POST /session/legacy/message?')) {
        json(response, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
      } else {
        json(response, true)
      }
    })
    const result = runOpenCodeTextTaskSession({
      version: 'v1',
      v1SessionPolicyFiltersTools: true,
      url,
      operation,
      directory: '/workspace',
      prompt: 'Name only',
      model: { providerID: 'selected', modelID: 'model' },
      variant: 'low',
      v1Files: [
        { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' }
      ],
      signal: new AbortController().signal
    })
    await expect(result).resolves.toBe('Harbor Lantern')
    expect(requests.get('POST /session/legacy/message?directory=%2Fworkspace')).toEqual({
      messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
      model: { providerID: 'selected', modelID: 'model' },
      variant: 'low',
      parts: [
        { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///notes.txt' },
        { type: 'text', text: 'Name only' }
      ],
      tools: {
        '*': false,
        read: true,
        grep: true,
        glob: true,
        external_directory: true,
        bash: false,
        edit: false,
        write: false,
        patch: false,
        apply_patch: false,
        multiedit: false,
        task: false,
        todowrite: false
      }
    })
    expect(requests.has('GET /event?directory=%2Fworkspace')).toBe(true)
    expect(requests.has('DELETE /session/legacy?directory=%2Fworkspace')).toBe(true)
  }
)

it.each(['permission.updated', 'permission.asked'])(
  'keeps a legacy fork command and rejects its owned %s through the native route',
  async (type) => {
    const requests = new Map<string, unknown>()
    let events: ServerResponse | undefined
    let command: ServerResponse | undefined
    const rejectPath =
      type === 'permission.updated'
        ? 'POST /session/forked/permissions/per_write?directory=%2Fworkspace'
        : 'POST /permission/per_write/reply?directory=%2Fworkspace'
    const url = await fixture((path, body, response) => {
      requests.set(path, body)
      if (path.startsWith('GET /session/saved?')) {
        json(response, { id: 'saved', directory: '/workspace' })
      } else if (path.startsWith('GET /agent?')) {
        json(response, [{ name: 'configured', mode: 'primary' }])
      } else if (path.startsWith('GET /command?')) {
        json(response, [{ name: 'inspect', agent: 'configured' }])
      } else if (path.startsWith('POST /session/saved/fork?')) {
        json(response, { id: 'forked' })
      } else if (path.startsWith('PATCH /session/forked?')) {
        json(response, { id: 'forked', permission: [] })
      } else if (path.startsWith('GET /event?')) {
        events = response
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
      } else if (path.startsWith('POST /session/forked/command?')) {
        command = response
        events!.write(
          `data: ${JSON.stringify({ type, properties: { sessionID: 'forked', id: 'per_write' } })}\n\n`
        )
      } else if (path === rejectPath) {
        expect(body).toMatchObject(
          type === 'permission.updated' ? { response: 'reject' } : { reply: 'reject' }
        )
        json(response, true)
        json(command!, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
      } else {
        json(response, true)
      }
    })
    await expect(
      runOpenCodeTextTaskSession({
        version: 'v1',
        v1SessionPolicyFiltersTools: true,
        url,
        directory: '/workspace',
        operation: 'conversation-name',
        sessionId: 'saved',
        fork: true,
        command: 'inspect',
        agent: 'configured',
        model: { providerID: 'selected', modelID: 'model' },
        prompt: 'Name only',
        signal: new AbortController().signal
      })
    ).resolves.toBe('Harbor Lantern')
    expect(requests.get('POST /session/forked/command?directory=%2Fworkspace')).toEqual({
      messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
      command: 'inspect',
      arguments: 'Name only',
      agent: 'configured',
      model: 'selected/model'
    })
    expect(requests.has(rejectPath)).toBe(true)
    expect(requests.has('DELETE /session/forked?directory=%2Fworkspace')).toBe(true)
    expect(
      [...requests.keys()].some((path) => /(?:PATCH|DELETE) \/session\/saved\?/.test(path))
    ).toBe(false)
  }
)

it.each(['applied', 'http-error', 'wrong-id', 'conflicting'])(
  'forks only the selected source and requires policy acknowledgement (%s)',
  async (outcome) => {
    const requests: string[] = []
    let policy: unknown
    const url = await fixture((path, body, response) => {
      requests.push(path)
      if (path.startsWith('GET /session/saved?')) {
        json(response, { id: 'saved', directory: '/workspace' })
      } else if (path.startsWith('POST /session/saved/fork?')) {
        json(response, { id: 'forked' })
      } else if (path.startsWith('PATCH /session/forked?')) {
        policy = body
        if (outcome === 'http-error') {
          response.statusCode = 400
        }
        json(response, {
          id: outcome === 'wrong-id' ? 'source' : 'forked',
          permission:
            outcome === 'conflicting'
              ? [...appliedV1Policy, { permission: 'edit', pattern: '*', action: 'allow' }]
              : [{ permission: 'bash', pattern: '*', action: 'allow' }, ...appliedV1Policy]
        })
      } else if (path.startsWith('POST /session/forked/message?')) {
        json(response, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
      } else {
        json(response, true)
      }
    })
    const result = runOpenCodeTextTaskSession({
      version: 'v1',
      v1SessionPolicyFiltersTools: true,
      url,
      directory: '/workspace',
      prompt: 'Name only',
      operation: 'conversation-name',
      sessionId: 'saved',
      fork: true,
      signal: new AbortController().signal
    })
    await (outcome === 'applied'
      ? expect(result).resolves.toBe('Harbor Lantern')
      : expect(result).rejects.toThrow(/rejected|different|did not apply/))
    expect(policy).toMatchObject({
      permission: [
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'grep', pattern: '*', action: 'allow' },
        { permission: 'glob', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'allow' },
        { permission: 'read', pattern: 'mcp:*', action: 'deny' }
      ]
    })
    expect(requests.some((path) => path.startsWith('POST /session/forked/message?'))).toBe(
      outcome === 'applied'
    )
    expect(requests).toContain('DELETE /session/forked?directory=%2Fworkspace')
    expect(
      requests.some((path) => /(?:PATCH|DELETE|POST) \/session\/saved\?(?:.*)/.test(path))
    ).toBe(false)
  }
)
