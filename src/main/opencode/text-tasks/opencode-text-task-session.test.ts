import { z } from 'zod'
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

it('recovers and deletes an owned session when cancelled during creation without sending a prompt', async () => {
  const controller = new AbortController()
  const requests: string[] = []
  const url = await fixture((path, _body, response) => {
    requests.push(path)
    if (path === 'GET /api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
    } else if (path === 'POST /api/session') {
      controller.abort(new Error('Renamed manually'))
      json(response, { data: { id: 'ses_late' } })
    } else {
      json(response, {})
    }
  })
  await expect(
    runOpenCodeTextTaskSession({
      version: 'v2',
      v1SessionPolicyFiltersTools: false,
      url,
      password: 'test',
      directory: '/workspace',
      prompt: 'Name this chat',
      signal: controller.signal
    })
  ).rejects.toThrow('Renamed manually')
  expect(requests).toContain('POST /api/session/ses_late/interrupt')
  expect(requests).toContain('DELETE /api/session/ses_late')
  expect(requests).not.toContain('POST /api/session/ses_late/prompt')
})

it('discards a cancelled borrowed v1 response without aborting or deleting its session', async () => {
  const controller = new AbortController()
  const submitted = Promise.withResolvers<void>()
  const requests: string[] = []
  let lateResponse: ServerResponse | undefined
  const url = await fixture((path, _body, response) => {
    requests.push(path)
    if (path.startsWith('GET /session/saved')) {
      json(response, { id: 'saved', directory: '/workspace' })
    } else if (path.startsWith('POST /session/saved/message?')) {
      lateResponse = response
      submitted.resolve()
    } else {
      response.statusCode = 400
      json(response, {})
    }
  })
  const result = runOpenCodeTextTaskSession({
    version: 'v1',
    v1SessionPolicyFiltersTools: true,
    url,
    directory: '/workspace',
    external: { url },
    exclusiveServer: false,
    sessionId: 'saved',
    operation: 'conversation-name',
    prompt: 'Name only',
    signal: controller.signal
  })
  const rejected = expect(result).rejects.toThrow('Renamed manually')
  await submitted.promise
  controller.abort(new Error('Renamed manually'))
  await rejected
  json(lateResponse!, {
    info: { parentID: 'msg_compaction_continue' },
    parts: [{ type: 'text', text: 'Late title' }]
  })
  expect(requests).toEqual([
    'GET /session/saved',
    'POST /session/saved/message?directory=%2Fworkspace'
  ])
})

it('cancels only its still-queued borrowed v2 input after a late admission response', async () => {
  const controller = new AbortController()
  const requests: string[] = []
  let messageID = ''
  const url = await fixture((path, body, response) => {
    requests.push(path)
    if (path === 'GET /api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
    } else if (path === 'GET /api/session/saved') {
      json(response, { data: { id: 'saved', location: { directory: '/server' } } })
    } else if (path === 'POST /api/session/saved/prompt') {
      messageID = z.object({ id: z.string() }).parse(body).id
      controller.abort(new Error('Renamed manually'))
      json(response, {})
    } else {
      json(response, {})
    }
  })
  await expect(
    runOpenCodeTextTaskSession({
      version: 'v2',
      v1SessionPolicyFiltersTools: false,
      url,
      directory: '/client',
      external: { url },
      exclusiveServer: false,
      prompt: 'Name only',
      sessionId: 'saved',
      operation: 'conversation-name',
      signal: controller.signal
    })
  ).rejects.toThrow('Renamed manually')
  expect(requests).toEqual([
    'GET /api/event',
    'GET /api/session/saved',
    'POST /api/session/saved/prompt',
    `DELETE /api/session/saved/inbox/${messageID}`
  ])
})

it('retains explicitly shared native history even when publication fails ambiguously', async () => {
  const requests: string[] = []
  const url = await fixture((path, _body, response) => {
    requests.push(path)
    if (path.startsWith('POST /session?')) {
      json(response, { id: 'retained', permission: appliedV1Policy })
    } else if (path.startsWith('POST /session/retained/share?')) {
      response.statusCode = 500
      json(response, {})
    } else if (path.startsWith('POST /session/retained/message?')) {
      json(response, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
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
      prompt: 'Name only',
      share: true,
      operation: 'conversation-name',
      signal: new AbortController().signal
    })
  ).resolves.toBe('Harbor Lantern')
  expect(requests).toEqual([
    'POST /session?directory=%2Fworkspace',
    'POST /session/retained/share?directory=%2Fworkspace',
    'POST /session/retained/message?directory=%2Fworkspace'
  ])
})
