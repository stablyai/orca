import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { structuredChatNamingDeps } from '../runtime/structured-chat-naming-runtime'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { getDefaultSettings } from '../../shared/constants'
import { FakeAcpChild } from './acp-scripted-connection.test-fixture'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { AcpLaunchGate } from './acp-launch-gate'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

const boundary = vi.hoisted(() => ({
  adapter: vi.fn<() => StructuredAgentSessionAdapter>(),
  afterTemp: vi.fn<(path: string) => Promise<void>>()
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: boundary.adapter() } })
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFsPromises>()
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const path = await fs.mkdtemp(prefix)
      await boundary.afterTemp(path)
      return path
    }
  }
})

const prompt = z.object({ _meta: z.object({ promptId: z.string() }) })
const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  boundary.afterTemp.mockReset()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function stagedRig(
  options: {
    antigravity?: boolean
    proveExit?: boolean
    deletion?: 'unsupported' | 'stalled'
    prepare?: () => Promise<Record<string, string>>
    onConnect?: () => void
    shouldExecute?: () => boolean
    close?: (child: FakeAcpChild) => Promise<boolean>
    runtime?: boolean
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
  const logger = { warn: vi.fn(), error: vi.fn() }
  const deps: AcpStructuredSessionAdapterDeps = {
    logger,
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
      if (options.close) {
        const close = options.close
        const connected = child
        child.proveClose = () => close(connected)
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
  const tasks = new AcpStructuredSessionAdapter(deps)
  const registry = new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(spec), adapter: tasks }
  ])
  const router = new StructuredAgentSessionAdapterRouter(registry, () => tasks.closeAll())
  boundary.adapter.mockReturnValue(router)
  const record = agentSessionRecordFixture()
  record.provider = spec.agent
  record.accountHome = { variable: options.antigravity ? 'GEMINI_HOME' : 'GROK_HOME', path: root }
  const naming = structuredChatNamingDeps(
    () => ({ getSettings: () => getDefaultSettings(root) }),
    {
      resolveWorkspace: async () => ({ path: root, executionHostId: 'local' }),
      resolveNamingEnvironment: async () => ({ PATH: '/usr/bin' }),
      getAgentEnvResolvers: () => undefined,
      workerTaskTitle: () => null,
      retitleOpenTab: () => {}
    },
    logger
  )
  const result = options.runtime
    ? naming.generate(record, 'Repair login')
    : router.generateText({
        agent: spec.agent,
        accountHome: record.accountHome,
        prompt: 'Name this chat',
        shouldExecute: options.shouldExecute
      })
  void result.catch(() => {})
  return { root, ready, result, tasks, logger, gate: spec.launchGate }
}

async function rig(options: Parameters<typeof stagedRig>[0] = {}) {
  const state = await stagedRig(options)
  const { root, ready, result, tasks } = state
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
  return { ...state, root, server, agent, frame, promptId, result, tasks, text }
}

it.each(['turn_completed', 'x.ai/session/prompt_complete', '_x.ai/session/prompt_complete'])(
  'settles matching Grok %s without waiting for its prompt RPC',
  async (method) => {
    const r = await rig()
    r.text('Repair login')
    const complete = (sessionId: string, promptId: string, stopReason: string) => {
      if (method === 'turn_completed') {
        r.agent.notify('session/update', {
          sessionId,
          update: { sessionUpdate: method, prompt_id: promptId, stop_reason: stopReason }
        })
      } else {
        r.agent.notify(method, { sessionId, promptId, stopReason })
      }
    }
    complete('other-session', r.promptId, 'error')
    complete('11111111-1111-4111-8111-111111111111', 'other-prompt', 'error')
    await Promise.resolve()
    expect(r.server.exited).toBe(false)
    complete('11111111-1111-4111-8111-111111111111', r.promptId, 'end_turn')
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
    const r = await rig({ deletion, shouldExecute: () => true })
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

it.each(['launch', 'private-temp'] as const)(
  'skips stale work after held %s preparation',
  async (stage) => {
    const entered = Promise.withResolvers<string>()
    const release = Promise.withResolvers<void>()
    let current = true
    const onConnect = vi.fn()
    if (stage === 'private-temp') {
      boundary.afterTemp.mockImplementation(async (path) => {
        if (path.includes('acp-temp')) {
          entered.resolve(path)
          await release.promise
        }
      })
    }
    const r = await stagedRig({
      antigravity: stage === 'private-temp',
      onConnect,
      shouldExecute: () => current,
      prepare: async () => {
        if (stage === 'launch') {
          entered.resolve('')
          await release.promise
        }
        return { PATH: '/usr/bin' }
      }
    })
    const folder = await entered.promise
    current = false
    release.resolve()
    expect(await r.result).toBeNull()
    expect(onConnect).not.toHaveBeenCalled()
    expect(r.logger.warn).not.toHaveBeenCalled()
    if (folder) {
      await vi.waitFor(async () => {
        await expect(access(folder)).rejects.toThrow()
      })
    }
  }
)

it.each(['success', 'failure', 'deadline'] as const)(
  'joins root and managed close on %s',
  async (outcome) => {
    vi.useFakeTimers()
    const closing = Promise.withResolvers<void>()
    const close = Promise.withResolvers<boolean>()
    const r = await rig({
      shouldExecute: () => true,
      close: async () => {
        closing.resolve()
        return close.promise
      }
    })
    const settled = vi.fn()
    void r.result.then(settled, settled)
    r.text('Repair login')
    if (outcome === 'deadline') {
      await vi.advanceTimersByTimeAsync(60_000)
    } else {
      r.agent.reply(r.frame, { stopReason: outcome === 'success' ? 'end_turn' : 'error' })
    }
    await closing.promise
    if (outcome === 'success') {
      r.server.exit()
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      close.resolve(true)
    } else {
      close.resolve(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).not.toHaveBeenCalled()
      r.server.exit()
    }
    if (outcome === 'success') {
      expect(await r.result).toBe('Repair login')
    } else {
      await expect(r.result).rejects.toThrow(
        outcome === 'deadline' ? 'timed out' : 'did not complete'
      )
    }
    expect(settled).toHaveBeenCalledTimes(1)
  }
)

it.each(['shutdown', 'account'] as const)(
  'allows %s to retry a retained root before releasing the caller',
  async (owner) => {
    const r = await rig({ proveExit: false, shouldExecute: () => true })
    const settled = vi.fn()
    void r.result.then(settled, settled)
    r.text('Repair login')
    r.agent.reply(r.frame, { stopReason: 'end_turn' })
    await vi.waitFor(() => expect(r.logger.warn).toHaveBeenCalled())
    expect(settled).not.toHaveBeenCalled()
    r.server.proveClose = async () => {
      r.server.exit()
      return true
    }
    const work = vi.fn(async () => {})
    if (owner === 'shutdown') {
      await r.tasks.closeAll()
    } else {
      await r.gate?.run(async () => {}, work)
      expect(work).toHaveBeenCalledOnce()
    }
    expect(await r.result).toBe('Repair login')
    expect(r.server.closes).toBe(2)
    expect(settled).toHaveBeenCalledTimes(1)
  }
)

it('runs healthy own-agent naming through the runtime, registered router and ACP task', async () => {
  const r = await rig({ runtime: true })
  expect(r.frame.params).toEqual(
    expect.objectContaining({
      prompt: [expect.objectContaining({ text: expect.stringContaining('Repair login') })]
    })
  )
  expect(r.server.launch.env?.GROK_HOME).toBe(r.root)
  expect(r.server.launch.args).toEqual(['agent', 'stdio'])
  r.text('Repair login\n')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  expect(await r.result).toEqual({ name: 'Repair login' })
  expect(r.logger.warn).not.toHaveBeenCalled()
  expect(r.server.exited).toBe(true)
})
