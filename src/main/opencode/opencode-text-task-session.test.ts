import { z } from 'zod'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
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
      v1SessionPolicyFiltersTools: false,
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

it('preserves a completed title when deleting its session fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const url = await fixture((path, _body, response) => {
    if (path.startsWith('POST /session?')) {
      json(response, { id: 'ses_cleanup', permission: appliedV1Policy })
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
        v1SessionPolicyFiltersTools: true,
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

it.each([false, true])(
  'correlates borrowed v2 admission and leaves unrelated work alone (superseded=%s)',
  async (superseded) => {
    const requests: string[] = []
    let events: ServerResponse | undefined
    const emit = (type: string, data: Record<string, unknown>) =>
      events!.write(`data: ${JSON.stringify({ type, data: { sessionID: 'saved', ...data } })}\n\n`)
    const url = await fixture((path, body, response) => {
      requests.push(path)
      if (path === 'GET /api/event') {
        events = response
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
      } else if (path === 'GET /api/session/saved') {
        json(response, { data: { id: 'saved', location: { directory: '/server' } } })
      } else if (path === 'POST /api/session/saved/prompt') {
        const input = z.object({ id: z.string(), delivery: z.literal('steer') }).parse(body)
        emit('session.text.ended', {
          assistantMessageID: 'msg_earlier',
          ordinal: 0,
          text: 'Wrong title'
        })
        emit('session.execution.succeeded', {})
        emit('session.inbox.delivered', { inboxID: input.id })
        emit('session.compaction.started', { reason: 'auto', recent: 'msg_history' })
        emit('session.compaction.ended', {
          reason: 'auto',
          text: 'This summary is context, not the requested title',
          recent: 'msg_history',
          model: { providerID: 'configured', id: 'model' },
          cost: 0,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
        })
        emit('permission.asked', { id: 'per_other_owner' })
        emit('session.step.started', { assistantMessageID: 'msg_ours' })
        emit('session.text.ended', {
          assistantMessageID: 'msg_ours',
          ordinal: 0,
          text: 'Harbor Lantern'
        })
        if (superseded) {
          emit('session.inbox.delivered', { inboxID: 'msg_later_input' })
        }
        emit('session.execution.succeeded', {})
        json(response, {})
      } else {
        json(response, {})
      }
    })
    const result = runOpenCodeTextTaskSession({
      version: 'v2',
      v1SessionPolicyFiltersTools: false,
      url,
      directory: '/client',
      external: { url },
      exclusiveServer: false,
      prompt: 'Name only',
      sessionId: 'saved',
      operation: 'conversation-name',
      signal: new AbortController().signal
    })
    await (superseded
      ? expect(result).rejects.toThrow('superseded')
      : expect(result).resolves.toBe('Harbor Lantern'))
    expect(requests).toEqual([
      'GET /api/event',
      'GET /api/session/saved',
      'POST /api/session/saved/prompt'
    ])
  }
)

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

it.each([false, true])(
  'rejects owned subtask asks with session routing field: %s',
  async (routing) => {
    let events: ServerResponse | undefined
    let readAllowed = false
    let deniedChild = false
    let deniedForeign = false
    let commandResponse: ServerResponse | undefined
    const url = await fixture((path, body, response) => {
      if (path.startsWith('GET /agent?')) {
        json(response, [{ name: 'reader', mode: 'subagent' }])
      } else if (path.startsWith('GET /command?')) {
        json(response, [
          { name: 'inspect', agent: 'reader', subtask: true, model: 'configured/command-model' }
        ])
      } else if (path.startsWith('POST /session?')) {
        const rules = z
          .object({
            permission: z.array(
              z.object({ permission: z.string(), pattern: z.string(), action: z.string() })
            )
          })
          .parse(body).permission
        // The native child retains denies and drops ordinary parent read allows.
        const childDenies = rules
          .filter((rule) => rule.action === 'deny')
          .map((rule) => rule.permission)
        expect(childDenies).toEqual(['read', 'bash', 'edit', 'todowrite'])
        readAllowed = !rules.some(
          (rule) =>
            rule.action === 'deny' &&
            rule.pattern === '*' &&
            ['*', 'read'].includes(rule.permission)
        )
        json(response, {
          id: 'root',
          permission: [
            { permission: '*', pattern: '*', action: 'ask' },
            ...appliedV1Policy.slice(1),
            { permission: 'bash', pattern: '*', action: 'deny' },
            { permission: 'edit', pattern: '*', action: 'deny' },
            { permission: 'todowrite', pattern: '*', action: 'deny' }
          ]
        })
      } else if (path.startsWith('GET /event?')) {
        events = response
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
      } else if (path.startsWith('POST /session/root/command?')) {
        expect(body).toMatchObject({
          command: 'inspect',
          arguments: 'Name from the recorded request',
          model: 'selected/model'
        })
        events!.write(
          `data: ${JSON.stringify({ type: 'session.created', properties: { info: { id: 'foreign_child', parentID: 'foreign_root' } } })}\n\n`
        )
        events!.write(
          `data: ${JSON.stringify({ type: 'permission.asked', properties: { sessionID: 'foreign_child', id: 'per_foreign' } })}\n\n`
        )
        events!.write(
          `data: ${JSON.stringify({ type: 'session.created', properties: { ...(routing ? { sessionID: 'child' } : {}), info: { id: 'child', parentID: 'root' } } })}\n\n`
        )
        events!.write(
          `data: ${JSON.stringify({ type: 'permission.asked', properties: { sessionID: 'child', id: 'per_child_shell' } })}\n\n`
        )
        commandResponse = response
      } else if (path.startsWith('POST /permission/per_foreign/reply?')) {
        deniedForeign = true
        json(response, true)
      } else if (path.startsWith('POST /permission/per_child_shell/reply?')) {
        expect(body).toMatchObject({ reply: 'reject' })
        deniedChild = true
        json(response, true)
        json(commandResponse!, {
          info: {},
          parts: [{ type: 'text', text: readAllowed ? 'Harbor Lantern' : 'Child read was denied' }]
        })
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
        command: 'inspect',
        model: { providerID: 'selected', modelID: 'model' },
        prompt: 'Name from the recorded request',
        operation: 'conversation-name',
        signal: new AbortController().signal
      })
    ).resolves.toBe('Harbor Lantern')
    expect(deniedChild).toBe(true)
    expect(deniedForeign).toBe(false)
  }
)
