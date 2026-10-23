import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AcpTextTasks } from './acp-text-task'
import { FakeAcpChild } from './acp-scripted-connection.test-fixture'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { AcpLaunchGate } from './acp-launch-gate'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

const prompt = z.object({ _meta: z.object({ promptId: z.string() }) })
const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function rig(
  options: {
    antigravity?: boolean
    proveExit?: boolean
    deletion?: 'unsupported' | 'stalled'
    prepare?: () => Promise<Record<string, string>>
    onConnect?: () => void
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-naming-task-test-'))
  folders.push(root)
  const base = acpLaunchSpecFor(options.antigravity ? 'antigravity' : 'grok')
  if (!base) {
    throw new Error('ACP spec is missing')
  }
  const spec: AcpLaunchSpec = {
    ...base,
    managedRuntime: undefined,
    launchGate: new AcpLaunchGate('Test')
  }
  let child: FakeAcpChild | undefined
  const ready = Promise.withResolvers<FakeAcpChild>()
  const deps: AcpStructuredSessionAdapterDeps = {
    spec,
    dataDirectory: root,
    readLaunch: async () => {
      throw new Error('Interactive launch must not be read')
    },
    resolveLaunch: async () => {
      throw new Error('Interactive chat must not be acquired')
    },
    textTaskLaunch: {
      dataDirectory: root,
      resolveEnvironment: options.prepare ?? (async () => ({ PATH: '/usr/bin' })),
      resolveCommand: () => '/fixture/agent'
    },
    connect: (launch, connectionOptions) => {
      options.onConnect?.()
      child = new FakeAcpChild(launch, connectionOptions)
      if (options.proveExit === false) {
        child.proveClose = async () => false
      }
      const agent = child.agent
      agent.on('initialize', (frame) =>
        agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
      )
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: '11111111-1111-4111-8111-111111111111' })
      )
      agent.on('_x.ai/session/delete', (frame) => {
        if (options.deletion === 'unsupported') {
          agent.fail(frame, -32601, 'Method not found')
        } else if (options.deletion !== 'stalled') {
          agent.reply(frame, { success: true })
        }
      })
      agent.on('session/prompt', () => {
        if (child) {
          ready.resolve(child)
        }
      })
      return child
    }
  }
  const tasks = new AcpTextTasks(deps)
  const result = tasks.generate({
    agent: spec.agent,
    accountHome: { variable: options.antigravity ? 'GEMINI_HOME' : 'GROK_HOME', path: root },
    prompt: 'Name this chat'
  })
  void result.catch(() => {})
  const server = await Promise.race([
    ready.promise,
    result.then(() => {
      throw new Error('No prompt started')
    })
  ])
  const agent = server.agent
  const frame = agent.frames.find((frame) => frame.method === 'session/prompt')
  if (!frame) {
    throw new Error('Naming prompt missing')
  }
  const promptId = prompt.parse(frame.params)._meta.promptId
  const text = (value: string) =>
    agent.notify('session/update', {
      sessionId: '11111111-1111-4111-8111-111111111111',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } }
    })
  return { root, server, agent, frame, promptId, result, tasks, text }
}

it.each(['turn_completed', 'x.ai/session/prompt_complete', '_x.ai/session/prompt_complete'])(
  'settles matching Grok %s without waiting for its prompt RPC',
  async (method) => {
    const r = await rig()
    r.text('Repair login')
    const complete = (sessionId: string, promptId: string) => {
      if (method === 'turn_completed') {
        r.agent.notify('session/update', {
          sessionId,
          update: { sessionUpdate: method, prompt_id: promptId, stop_reason: 'end_turn' }
        })
      } else {
        r.agent.notify(method, { sessionId, promptId, stopReason: 'end_turn' })
      }
    }
    complete('other-session', r.promptId)
    complete('11111111-1111-4111-8111-111111111111', 'other-prompt')
    await Promise.resolve()
    expect(r.server.exited).toBe(false)
    complete('11111111-1111-4111-8111-111111111111', r.promptId)
    expect(await r.result).toBe('Repair login')
    const start = r.agent.frames.find((frame) => frame.method === 'session/new')
    expect(start?.params).toEqual({ cwd: r.server.launch.cwd, mcpServers: [] })
    expect(r.server.launch.args).toEqual(['agent', 'stdio'])
    expect(r.server.exited).toBe(true)
    expect(
      r.agent.frames.some((frame) =>
        ['session/load', 'session/resume', 'session/fork', 'session/cancel'].includes(
          frame.method ?? ''
        )
      )
    ).toBe(false)
    expect(r.agent.frames.find((frame) => frame.method === '_x.ai/session/delete')?.params).toEqual(
      { sessionId: '11111111-1111-4111-8111-111111111111', cwd: r.server.launch.cwd }
    )
    await expect(access(r.server.launch.cwd!)).rejects.toThrow()
  }
)

it.each(['unsupported', 'stalled'] as const)(
  'preserves a title after %s deletion and closes',
  async (deletion) => {
    vi.useFakeTimers()
    const r = await rig({ deletion })
    r.text('Repair login')
    r.agent.reply(r.frame, { stopReason: 'end_turn' })
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await r.result).toBe('Repair login')
    expect(r.server.exited).toBe(true)
  }
)

it('rejects standalone failure and cancels before deleting and closing', async () => {
  const r = await rig()
  r.agent.notify('_x.ai/session/prompt_complete', {
    sessionId: '11111111-1111-4111-8111-111111111111',
    promptId: r.promptId,
    stopReason: 'error'
  })
  await expect(r.result).rejects.toThrow('did not complete')
  const methods = r.agent.frames.map((frame) => frame.method)
  expect(methods.indexOf('session/cancel')).toBeLessThan(methods.indexOf('_x.ai/session/delete'))
  expect(r.server.exited).toBe(true)
})

it('does not spawn when preparation finishes after the deadline', async () => {
  vi.useFakeTimers()
  const prepare = Promise.withResolvers<Record<string, string>>()
  const onConnect = vi.fn()
  const preparing = Promise.withResolvers<void>()
  const fixture = rig({
    prepare: () => {
      preparing.resolve()
      return prepare.promise
    },
    onConnect
  })
  const failure = expect(fixture).rejects.toThrow('Chat naming timed out')
  await preparing.promise
  await vi.advanceTimersByTimeAsync(60_000)
  await failure
  prepare.resolve({ PATH: '/usr/bin' })
  await vi.advanceTimersByTimeAsync(0)
  expect(onConnect).not.toHaveBeenCalled()
})

it.each(['tool', 'overflow', 'shutdown'] as const)(
  'closes the helper after %s',
  async (failure) => {
    const r = await rig()
    if (failure === 'tool') {
      r.agent.notify('session/update', {
        sessionId: '11111111-1111-4111-8111-111111111111',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'Shell',
          status: 'in_progress'
        }
      })
    }
    if (failure === 'overflow') {
      r.text('x'.repeat(128_001))
    }
    if (failure === 'shutdown') {
      await r.tasks.closeAll()
    }
    await expect(r.result).rejects.toThrow()
    expect(r.server.exited).toBe(true)
  }
)

it('enforces the task deadline and tears down its child', async () => {
  vi.useFakeTimers()
  const r = await rig()
  const failure = expect(r.result).rejects.toThrow('Chat naming timed out')
  await vi.advanceTimersByTimeAsync(60_000)
  await failure
  expect(r.server.exited).toBe(true)
})

it('removes only its owned Antigravity session files after proven exit, including late exit', async () => {
  const r = await rig({ antigravity: true, proveExit: false })
  const session = '11111111-1111-4111-8111-111111111111'
  const directory = join(r.root, 'antigravity-acp', 'conversations')
  await mkdir(directory, { recursive: true })
  const metadata = join(directory, `${session}.meta`)
  await writeFile(metadata, JSON.stringify({ cwd: r.server.launch.cwd }))
  await writeFile(join(directory, 'keep.meta'), '{}')
  r.text('Repair login')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  expect(await r.result).toBe('Repair login')
  expect(await readFile(metadata, 'utf8')).toContain(r.server.launch.cwd)
  r.server.exit()
  await vi.waitFor(async () => {
    await expect(access(metadata)).rejects.toThrow()
  })
  expect(await readFile(join(directory, 'keep.meta'), 'utf8')).toBe('{}')
})
