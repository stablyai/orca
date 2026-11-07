import type { AntigravityChatAuthConfig } from '../../shared/antigravity-chat-auth-config'
import { readAcpFixture } from './acp-timeline-fixture.test-support'
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  access,
  symlink,
  realpath
} from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/providers/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-router'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { structuredChatNamingDeps } from '../runtime/agent-session/naming/structured-chat-naming-runtime'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { getDefaultSettings } from '../../shared/constants'
import { FakeAcpChild } from './acp-scripted-connection.test-fixture'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { AcpLaunchGate } from './acp-launch-gate'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { InitializeResponse } from './generated/acp-protocol.generated'
import type * as GrokTextTaskModule from '../grok/grok-text-task'
import { runGrokTextTask } from '../grok/grok-text-task'
vi.mock('../grok/grok-text-task', async (original) => ({
  ...(await original<typeof GrokTextTaskModule>()),
  runGrokTextTask: vi.fn()
}))

const boundary = vi.hoisted(() => ({
  adapter: vi.fn<() => StructuredAgentSessionAdapter>(),
  afterTemp: vi.fn<(path: string) => Promise<void>>(),
  taskTempParent: '',
  failTaskRealpath: false
}))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: boundary.adapter() } })
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFsPromises>()
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const path = await fs.mkdtemp(
        boundary.taskTempParent && prefix.includes('orca-chat-name-')
          ? join(boundary.taskTempParent, 'orca-chat-name-')
          : prefix
      )
      await boundary.afterTemp(path)
      return path
    },
    realpath: async (path: string) => {
      if (boundary.failTaskRealpath && path.includes('orca-chat-name-')) {
        throw new Error('Task directory resolution failed')
      }
      return fs.realpath(path)
    }
  }
})

const prompt = z.object({ _meta: z.object({ promptId: z.string() }) })
const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  boundary.afterTemp.mockReset()
  boundary.taskTempParent = ''
  boundary.failTaskRealpath = false
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function stagedRig(
  options: {
    antigravity?: boolean
    authConfig?: AntigravityChatAuthConfig
    modeFailure?: boolean
    deletion?: 'unsupported' | 'stalled'
    proveExit?: boolean
    initialized?: InitializeResponse
    prepare?: () => Promise<Record<string, string>>
    onConnect?: () => void
    shouldExecute?: () => boolean
    close?: (child: FakeAcpChild) => Promise<boolean>
    runtime?: boolean
    requireAuth?: boolean
  } = {}
) {
  // Short on POSIX so the private temp root stays in this folder, not /tmp/oacp-*.
  const root = await mkdtemp(
    process.platform === 'win32' ? join(tmpdir(), 'orca-naming-task-test-') : '/tmp/o'
  )
  folders.push(root)
  const initialized = options.authConfig
    ? (await readAcpFixture('antigravity-v1-question'))[0]?.message.result
    : { protocolVersion: 1, agentCapabilities: {} }
  const base = acpLaunchSpecFor(options.antigravity !== false ? 'antigravity' : 'grok')
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
      resolveCommand: () => '/fixture/agent',
      resolveCommandSettings: () => ({ antigravityChatAuth: options.authConfig })
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
      agent.on('initialize', (frame) => agent.reply(frame, options.initialized ?? initialized))
      let authenticated = false
      agent.on('authenticate', (frame) => {
        authenticated = true
        agent.reply(frame, {})
      })
      agent.on('_x.ai/session/delete', (frame) => {
        if (options.deletion === 'unsupported') {
          agent.fail(frame, -32601, 'Method not found')
        } else if (options.deletion !== 'stalled') {
          agent.reply(frame, { success: true })
        }
      })
      agent.on('session/new', (frame) => {
        if ((options.requireAuth || options.authConfig) && !authenticated) {
          agent.fail(frame, -32000, 'Login required')
        } else {
          agent.reply(frame, { sessionId: '11111111-1111-4111-8111-111111111111' })
        }
      })
      agent.on('session/set_config_option', (frame) => {
        if (options.modeFailure) {
          agent.fail(frame, -32602, 'Mode control rejected')
        } else {
          agent.reply(frame, { configOptions: [] })
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
  record.accountHome = {
    variable: spec.agent === 'antigravity' ? 'GEMINI_HOME' : 'GROK_HOME',
    path: root
  }
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
  return { root, ready, result, tasks, logger, gate: spec.launchGate, child: () => child }
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

it.each(['success', 'failure'] as const)(
  'deletes only the owned Grok session after its headless writer settles on %s',
  async (outcome) => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-naming-path-test-'))
    folders.push(parent)
    const physical = join(await realpath(parent), 'physical')
    await mkdir(physical)
    const alias = join(parent, 'alias')
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
    boundary.taskTempParent = alias
    const writer = Promise.withResolvers<string>()
    const launched = Promise.withResolvers<Parameters<typeof runGrokTextTask>[0]>()
    vi.mocked(runGrokTextTask).mockImplementationOnce((input) => {
      launched.resolve(input)
      return writer.promise
    })
    const r = await stagedRig({
      antigravity: false,
      runtime: true,
      initialized: {
        protocolVersion: 1,
        authMethods: [{ id: 'cached_token', name: 'Saved login' }],
        _meta: { defaultAuthMethodId: 'cached_token' }
      }
    })
    const input = await launched.promise
    const child = r.child()!
    expect(input).toMatchObject({
      launch: { command: '/fixture/agent', env: { GROK_HOME: r.root, GROK_STORAGE_MODE: 'local' } },
      prompt: expect.stringContaining('Repair login'),
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
    expect(input.cwd).toBe(join(physical, basename(input.cwd)))
    expect(child.launch.cwd).toBe(input.cwd)
    expect(child.launch.env?.GROK_STORAGE_MODE).toBe('local')
    expect(child.launch.args).toEqual([
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio'
    ])
    expect(child.exited).toBe(false)
    expect(child.agent.frames.some((frame) => frame.method === '_x.ai/session/delete')).toBe(false)
    if (outcome === 'success') {
      writer.resolve('Repair login\n')
      expect(await r.result).toEqual({ name: 'Repair login' })
    } else {
      writer.reject(new Error('Writer failed after shutdown'))
      await expect(r.result).resolves.toMatchObject({ errorCode: 'grokFailed' })
    }
    expect(
      child.agent.frames.find((frame) => frame.method === '_x.ai/session/delete')?.params
    ).toEqual({ sessionId: input.sessionId, cwd: input.cwd })
    expect(
      child.agent.frames.some((frame) =>
        ['session/new', 'session/prompt'].includes(frame.method ?? '')
      )
    ).toBe(false)
    expect(child.exited).toBe(true)
    await expect(access(input.cwd)).rejects.toThrow()
  }
)

it('removes the allocated Grok directory without starting a child when canonicalization fails', async () => {
  let allocated = ''
  boundary.afterTemp.mockImplementation(async (path) => {
    if (path.includes('orca-chat-name-')) {
      allocated = path
    }
  })
  boundary.failTaskRealpath = true
  const r = await stagedRig({ antigravity: false })
  await expect(r.result).rejects.toThrow('Task directory resolution failed')
  expect(allocated).not.toBe('')
  await expect(access(allocated)).rejects.toThrow()
  expect(r.child()).toBeUndefined()
  expect(runGrokTextTask).not.toHaveBeenCalled()
})

it('names on the normal Grok account when headless selects a different account', async () => {
  const r = await rig({
    antigravity: false,
    requireAuth: true,
    prepare: async () => ({ PATH: '/usr/bin', XAI_API_KEY: 'fixture-only' }),
    initialized: {
      protocolVersion: 1,
      authMethods: [
        { id: 'xai.api_key', name: 'API key' },
        { id: 'cached_token', name: 'Saved login' }
      ],
      _meta: { defaultAuthMethodId: 'cached_token' }
    }
  })
  expect(runGrokTextTask).not.toHaveBeenCalled()
  expect(r.agent.frames.find((frame) => frame.method === 'authenticate')?.params).toEqual({
    methodId: 'xai.api_key'
  })
  expect(r.agent.frames.find((frame) => frame.method === 'session/new')?.params).toEqual({
    cwd: await realpath(r.server.launch.cwd!),
    mcpServers: [],
    _meta: { yoloMode: false, autoMode: false }
  })
  r.text('Harbor Lantern')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  await expect(r.result).resolves.toBe('Harbor Lantern')
  expect(r.agent.frames.find((frame) => frame.method === '_x.ai/session/delete')?.params).toEqual({
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: r.server.launch.cwd
  })
  expect(r.child()?.exited).toBe(true)
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
  expect(r.server.launch.env?.GEMINI_HOME).toBe(r.root)
  expect(r.server.launch.args).toEqual(process.platform === 'linux' ? ['--uid='] : [])
  r.text('Repair login\n')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  expect(await r.result).toEqual({ name: 'Repair login' })
  expect(r.logger.warn).not.toHaveBeenCalled()
  expect(r.server.exited).toBe(true)
})

it('naming uses the same configured Enterprise method as Chat with recorded auth advertisement', async () => {
  const r = await rig({
    antigravity: true,
    authConfig: {
      method: 'oauth-business',
      gcpProject: 'enterprise-project',
      gcpLocation: 'us-central1'
    }
  })
  expect(r.agent.frames.find((frame) => frame.method === 'authenticate')?.params).toEqual({
    methodId: 'oauth-business'
  })
  r.text('Enterprise reply')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  expect(await r.result).toBe('Enterprise reply')
  const config = JSON.parse(
    await readFile(join(r.root, 'antigravity-acp', 'settings.json'), 'utf8')
  )
  expect(config).toEqual({
    auth: { type: 'oauth-business' },
    gcp: { project: 'enterprise-project', location: 'us-central1' }
  })
})

it('applies Antigravity default mode and returns its advertised denial before completing', async () => {
  const r = await rig({ antigravity: true })
  expect(
    r.agent.frames.find((frame) => frame.method === 'session/set_config_option')?.params
  ).toEqual({
    sessionId: '11111111-1111-4111-8111-111111111111',
    configId: 'mode',
    value: 'default'
  })
  const response = await r.agent.request('permission', 'session/request_permission', {
    sessionId: '11111111-1111-4111-8111-111111111111',
    toolCall: { toolCallId: 'shell-call', title: 'run_shell_command', kind: 'execute' },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny', name: 'Reject once', kind: 'reject_once' }
    ]
  })
  expect(response).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'deny' } } })
  r.text('Harbor Lantern')
  r.agent.reply(r.frame, { stopReason: 'end_turn' })
  expect(await r.result).toBe('Harbor Lantern')
  expect(r.server.exited).toBe(true)
})

it('never prompts Antigravity after rejection of its task permission mode', async () => {
  const r = await stagedRig({ antigravity: true, modeFailure: true })
  await expect(r.result).rejects.toThrow('Mode control rejected')
  await r.tasks.closeAll()
})
