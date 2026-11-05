import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { runOpenCodeTextTaskSession } from './opencode-text-task-session'

const servers: ReturnType<typeof createServer>[] = []
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

it('v1 applies ordered session authority and preserves the selected native prompt', async () => {
  const requests = new Map<string, unknown>()
  const url = await fixture((path, body, response) => {
    requests.set(path, body)
    if (path.startsWith('GET /agent?')) {
      json(response, [{ name: 'configured-agent', mode: 'primary' }])
    } else if (path.startsWith('POST /session?')) {
      json(response, { id: 'ses_v1' })
    } else if (path.startsWith('POST /session/ses_v1/message?')) {
      json(response, {
        info: {},
        parts: [
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: 'Harbor Lantern' }
        ]
      })
    } else {
      json(response, true)
    }
  })
  await expect(
    runOpenCodeTextTaskSession({
      version: 'v1',
      url,
      password: 'test',
      directory: '/workspace with spaces',
      prompt: 'Name this chat',
      agent: 'configured-agent',
      model: { providerID: 'opencode', modelID: 'crouton-alpha-free' },
      variant: 'low',
      signal: new AbortController().signal
    })
  ).resolves.toBe('Harbor Lantern')
  expect(requests.get('POST /session?directory=%2Fworkspace%20with%20spaces')).toEqual({
    title: expect.stringMatching(/^Orca text generation /),
    agent: 'configured-agent',
    permission: [
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: 'mcp:*', action: 'deny' }
    ]
  })
  expect(
    requests.get('POST /session/ses_v1/message?directory=%2Fworkspace%20with%20spaces')
  ).toEqual({
    model: { providerID: 'opencode', modelID: 'crouton-alpha-free' },
    agent: 'configured-agent',
    variant: 'low',
    parts: [{ type: 'text', text: 'Name this chat' }]
  })
  expect(requests.has('DELETE /session/ses_v1?directory=%2Fworkspace%20with%20spaces')).toBe(true)
})

it('v2 rejects an unexpected permission and reads final text across fragmented CRLF events', async () => {
  let events: ServerResponse | undefined
  const requests = new Map<string, unknown>()
  const emit = (
    type: string,
    data: { id?: string; assistantMessageID?: string; ordinal?: number; text?: string }
  ) => {
    if (!events) {
      throw new Error('No event subscription')
    }
    const frame = `data: ${JSON.stringify({ type, data: { sessionID: 'ses_v2', ...data } })}\r\n\r\n`
    events.write(frame.slice(0, -3))
    events.write(frame.slice(-3))
  }
  const url = await fixture((path, body, response) => {
    requests.set(path, body)
    if (path === 'GET /api/event') {
      events = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
    } else if (path === 'POST /api/session') {
      json(response, { data: { id: 'ses_v2' } })
    } else if (path === 'POST /api/session/ses_v2/prompt') {
      json(response, {})
      emit('permission.asked', { id: 'per_shell' })
    } else if (path === 'POST /api/session/ses_v2/permission/per_shell/reply') {
      json(response, {})
      emit('session.text.ended', {
        assistantMessageID: 'msg_final',
        ordinal: 0,
        text: 'Harbor Lantern'
      })
      emit('session.execution.succeeded', {})
    } else {
      json(response, {})
    }
  })
  await expect(
    runOpenCodeTextTaskSession({
      version: 'v2',
      url,
      password: 'test',
      directory: '/workspace',
      prompt: 'Name this chat',
      model: { providerID: 'opencode', modelID: 'crouton-alpha-free' },
      variant: 'low',
      signal: new AbortController().signal
    })
  ).resolves.toBe('Harbor Lantern')
  expect(requests.get('POST /api/session')).toEqual({
    title: expect.stringMatching(/^Orca text generation /),
    location: { directory: '/workspace' },
    model: { providerID: 'opencode', id: 'crouton-alpha-free', variant: 'low' },
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'grep', resource: '*', effect: 'allow' },
      { action: 'glob', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'allow' },
      { action: 'read', resource: 'mcp:*', effect: 'deny' }
    ]
  })
  expect(requests.get('POST /api/session/ses_v2/permission/per_shell/reply')).toEqual({
    decision: 'reject',
    message: 'Tools are unavailable for this text task.'
  })
  expect(requests.has('DELETE /api/session/ses_v2')).toBe(true)
})

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

it('uses the native v1 command endpoint with its arguments and selected model', async () => {
  const requests = new Map<string, unknown>()
  const url = await fixture((path, body, response) => {
    requests.set(path, body)
    if (path.startsWith('POST /session?')) {
      json(response, { id: 'ses_command' })
    } else if (path.startsWith('GET /command?')) {
      json(response, [{ name: 'review', agent: 'reviewer' }])
    } else if (path.startsWith('GET /agent?')) {
      json(response, [
        { name: 'reviewer', mode: 'primary' },
        { name: 'build', mode: 'primary' }
      ])
    } else if (path.startsWith('POST /session/ses_command/command?')) {
      json(response, {
        info: {},
        parts: [{ type: 'text', text: 'Harbor Lantern' }]
      })
    } else {
      json(response, true)
    }
  })
  await expect(
    runOpenCodeTextTaskSession({
      version: 'v1',
      url,
      password: 'test',
      directory: '/workspace',
      prompt: 'extra\ngenerated',
      command: 'review',
      agent: 'build',
      title: 'Recipe',
      model: { providerID: 'opencode', modelID: 'crouton-alpha-free' },
      variant: 'low',
      signal: new AbortController().signal
    })
  ).resolves.toBe('Harbor Lantern')
  expect(requests.get('POST /session/ses_command/command?directory=%2Fworkspace')).toEqual({
    command: 'review',
    arguments: 'extra\ngenerated',
    agent: 'build',
    model: 'opencode/crouton-alpha-free',
    variant: 'low'
  })
  expect(requests.has('POST /session/ses_command/message?directory=%2Fworkspace')).toBe(false)
})

it('preserves a completed title when deleting its session fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const url = await fixture((path, _body, response) => {
    if (path.startsWith('POST /session?')) {
      json(response, { id: 'ses_cleanup' })
    } else if (path.startsWith('POST /session/ses_cleanup/message?')) {
      json(response, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
    } else {
      response.writeHead(500).end()
    }
  })
  try {
    await expect(
      runOpenCodeTextTaskSession({
        version: 'v1',
        url,
        password: 'test',
        directory: '/workspace',
        prompt: 'Name this chat',
        signal: new AbortController().signal
      })
    ).resolves.toBe('Harbor Lantern')
  } finally {
    warning.mockRestore()
  }
})

it.each(['', 'missing', 'explore'])(
  'v1 preserves default-agent fallback for %j in a normal command',
  async (agent) => {
    let submitted: unknown
    const url = await fixture((path, body, response) => {
      if (path.startsWith('GET /agent?')) {
        json(response, [
          { name: 'explore', mode: 'subagent' },
          { name: 'build', mode: 'primary' }
        ])
      } else if (path.startsWith('GET /command?')) {
        json(response, [{ name: 'review' }])
      } else if (path.startsWith('POST /session?')) {
        json(response, { id: 'ses_default' })
      } else if (path.startsWith('POST /session/ses_default/command?')) {
        submitted = body
        json(response, { info: {}, parts: [{ type: 'text', text: 'Harbor Lantern' }] })
      } else {
        json(response, true)
      }
    })
    await expect(
      runOpenCodeTextTaskSession({
        version: 'v1',
        url,
        password: 'test',
        directory: '/workspace',
        prompt: 'input',
        command: 'review',
        agent,
        signal: new AbortController().signal
      })
    ).resolves.toBe('Harbor Lantern')
    expect(submitted).toEqual({ command: 'review', arguments: 'input' })
  }
)
