import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { getDshConsoleStatusPluginSource } from './status-plugin-source'

// Execute the actual emitted module against the public Cordis event signatures.
it('observes real-shaped turns and interactive waterfalls without consuming answers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-dsh-module-'))
  const messages: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    expect(request.url).toBe('/hook/dsh-console')
    expect(request.headers['x-orca-agent-hook-token']).toBe('test-hook-token')
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      messages.push(JSON.parse(body).payload)
      response.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  vi.stubEnv('ORCA_PANE_KEY', 'test-pane')
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'test-launch')
  vi.stubEnv('ORCA_AGENT_HOOK_TOKEN', 'test-hook-token')
  vi.stubEnv('ORCA_AGENT_HOOK_PORT', String(address.port))
  vi.stubEnv('ORCA_AGENT_HOOK_ENDPOINT', '')
  const file = join(directory, 'index.mjs')
  await writeFile(file, getDshConsoleStatusPluginSource())
  const plugin = await import(/* @vite-ignore */ pathToFileURL(file).href)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const id = 'dsh-console-12345678-1234-1234-1234-123456789abc'
  const agent = { id, session: { id } }
  const ctx = {
    agents: { get: (key: string) => (key === id ? agent : undefined), roots: () => [agent] },
    on: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback)
  }
  try {
    plugin.apply(ctx)
    const event = (type: string, data: Record<string, unknown>) =>
      handlers.get('session/event')!(agent.session, { type, data })
    handlers.get('agent/session-start')!({ agent })
    event('turn/start', { turn: 1 })
    event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Choose a color' }]
    })
    let answer!: (value: string) => void
    const pending = handlers.get('user-questions/request')!(
      { agent, questions: [{ question: 'Which color?', options: [{ label: 'Blue' }] }] },
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        })
    )
    await vi.waitFor(() => expect(messages.at(-1)?.state).toBe('waiting'))
    expect(messages.at(-1)?.interactive_prompt).toContain('Which color?')
    answer('Blue')
    await expect(pending).resolves.toBe('Blue')
    await vi.waitFor(() => expect(messages.at(-1)?.state).toBe('working'))
    const failure = new Error('cancelled by native UI')
    await expect(
      handlers.get('approval/request')!({ agent, toolName: 'bash', reason: 'write access' }, () =>
        Promise.reject(failure)
      )
    ).rejects.toBe(failure)
    event('assistant/message', { message: { content: [{ type: 'text', text: 'Blue' }] } })
    event('turn/end', { reason: { kind: 'aborted' } })
    await vi.waitFor(() => expect(messages.at(-1)?.hook_event_name).toBe('Stop'))
    expect(messages.at(-1)).toMatchObject({
      state: 'done',
      is_interrupt: true,
      last_assistant_message: 'Blue',
      session_id: id
    })
    expect(messages.some((message) => message.state === 'blocked')).toBe(true)
    const count = messages.length
    handlers.get('session/event')!(
      { id: 'dsh-console-completion-123' },
      { type: 'turn/start', data: { turn: 1 } }
    )
    await handlers.get('dispose')!()
    expect(messages).toHaveLength(count)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
afterEach(() => vi.unstubAllEnvs())

it('bounds a trickling receiver and closes requests on disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-dsh-timeout-'))
  let requests = 0
  let open = 0
  const server = createServer((request, response) => {
    requests += 1
    open += 1
    request.resume()
    response.writeHead(200)
    const timer = setInterval(() => response.write(' '), 25)
    response.on('close', () => {
      clearInterval(timer)
      open -= 1
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('ORCA_PANE_KEY', 'test-pane')
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'test-launch')
  vi.stubEnv('ORCA_AGENT_HOOK_TOKEN', 'test-hook-token')
  vi.stubEnv('ORCA_AGENT_HOOK_PORT', String((server.address() as { port: number }).port))
  vi.stubEnv('ORCA_AGENT_HOOK_ENDPOINT', '')
  const file = join(directory, 'index.mjs')
  await writeFile(file, getDshConsoleStatusPluginSource())
  const plugin = await import(/* @vite-ignore */ pathToFileURL(file).href)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const id = 'dsh-console-12345678-1234-1234-1234-123456789abc'
  const agent = { id, session: { id } }
  try {
    plugin.apply({
      agents: { get: () => agent, roots: () => [agent] },
      on: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback)
    })
    handlers.get('agent/session-start')!({ agent })
    handlers.get('session/event')!(agent.session, { type: 'turn/start', data: { turn: 1 } })
    handlers.get('session/event')!(agent.session, {
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } }
    })
    await vi.waitFor(() => expect(requests).toBeGreaterThanOrEqual(2), { timeout: 1800 })
    await handlers.get('dispose')!()
    await vi.waitFor(() => expect(open).toBe(0))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
