import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  savedChatNamingCatalog,
  observeChatNamingCatalogWork
} from '../../shared/chat-naming-catalog-work.test-fixture'
import type { SourceControlActionRecipe } from '../../shared/source-control-ai-actions'
import type { SpawnSourceControlAgent } from '../text-generation/source-control-text-generation-types'
import { createMockDiscoveryChild } from '../text-generation/commit-message-text-generation-test-harness'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AcpTextTasks } from '../acp/acp-text-task'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { FakeAcpChild } from '../acp/acp-scripted-connection.test-fixture'
import recordings from './__fixtures__/chat-naming-recorded-output.json'

const boundary = vi.hoisted(() => ({
  spawn: vi.fn<SpawnSourceControlAgent>(),
  native: vi.fn<NonNullable<StructuredAgentSessionAdapter['generateText']>>(),
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  }))
}))
vi.mock('../text-generation/source-control-agent-launch', () => ({
  spawnSourceControlAgent: boundary.spawn
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: { generateText: boundary.native } } })
}))
vi.mock('../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: boundary.account
  })
}))
beforeEach(() => {
  vi.clearAllMocks()
  boundary.spawn.mockReset()
  boundary.native.mockReset()
  vi.stubEnv('ORCA_PI_SOURCE_AGENT_DIR', undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function rig() {
  const settings = getDefaultSettings('/isolated')
  settings.defaultTuiAgent = 'codex'
  settings.sourceControlAi = savedChatNamingCatalog(0)
  const env = {
    PATH: '/usr/bin',
    PI_CODING_AGENT_DIR: '/configured/pi',
    OPENCODE_CONFIG_DIR: '/configured/oc',
    OPENCODE_AUTH_CONTENT: 'current-account-sentinel'
  }
  const runtime = {
    resolveWorkspace: vi.fn(
      async (): Promise<{ path: string; executionHostId: ExecutionHostId }> => ({
        path: '/workspace/folder',
        executionHostId: 'local'
      })
    ),
    resolveNamingEnvironment: vi.fn(async () => env),
    getAgentEnvResolvers: () => ({ resolveBaseEnvironment: async () => env }),
    workerTaskTitle: () => null,
    retitleOpenTab: () => {}
  }
  return {
    settings,
    runtime,
    deps: structuredChatNamingDeps(() => ({ getSettings: () => settings }), runtime, {
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}

function reply(stdout: string, stderr = '', code = 0) {
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.stderr.emit('data', Buffer.from(stderr))
      child.emit('exit', code, null)
      child.emit('close', code, null)
    })
  )
  boundary.spawn.mockReturnValue(child)
  return child
}

function nativeReply() {
  const spec = acpLaunchSpecFor('grok')
  if (!spec) {
    throw new Error('Missing native task spec')
  }
  const tasks = new AcpTextTasks({
    spec,
    dataDirectory: '/fixture/state',
    textTaskLaunch: {
      dataDirectory: '/fixture/state',
      inheritedEnv: {},
      homePath: '/fixture',
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/fixture/grok'
    },
    connect: (launch, options) => {
      expect(launch.env?.GROK_HOME).toBe('/recorded/grok')
      const child = new FakeAcpChild(launch, options)
      const { agent } = child
      const sessionId = '11111111-1111-4111-8111-111111111111'
      agent.on('initialize', (frame) =>
        agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
      )
      agent.on('session/new', (frame) => agent.reply(frame, { sessionId }))
      agent.on('_x.ai/session/delete', (frame) => agent.reply(frame, { success: true }))
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Native title' }
          }
        })
        agent.reply(frame, { stopReason: 'end_turn' })
      })
      return child
    }
  })
  boundary.native.mockImplementation(tasks.generate)
  onTestFinished(async () => {
    await tasks.closeAll()
  })
}

it.each(recordings)(
  'consumes recorded $provider output through runtime, request, planner and parser',
  async (capture) => {
    const { provider, stdout, stderr, exitCode, name, error } = capture
    if (!isTuiAgent(provider)) {
      throw new Error('Unknown recorded provider')
    }
    expect(createHash('sha256').update(stdout).digest('hex')).toBe(capture.stdoutSha256)
    expect(createHash('sha256').update(stderr).digest('hex')).toBe(capture.stderrSha256)
    const state = rig()
    const source = state.settings.sourceControlAi
    const spec = getCommitMessageAgentSpec(provider)
    if (!source || !spec) {
      throw new Error('Missing naming configuration')
    }
    source.agentId = 'codex'
    if (provider === 'pi') {
      source.selectedModelByAgent.pi = 'openai/gpt-6.1-sol'
      source.discoveredModelsByAgent = {
        pi: [{ id: 'openai/gpt-6.1-sol', label: 'Recorded model' }]
      }
    }
    const record = agentSessionRecordFixture()
    record.provider = provider
    record.accountHome =
      provider === 'opencode' || provider === 'opencode2'
        ? { kind: 'opencode', locator: { kind: 'managed', managedProfileId: 'recorded' } }
        : { variable: 'PI_CODING_AGENT_DIR', path: '/recorded/pi' }
    const prompt = `Name this chat from the user's first request.
Write a short, specific title of at most 48 characters.
Output only the title, with no heading, quotes, or explanation.

First request:
Repair login`
    const child = reply(stdout, stderr, exitCode)
    let promptPath = ''
    if (spec.promptDelivery === 'file') {
      boundary.spawn.mockImplementationOnce((input) => {
        promptPath = input.args.find((arg) => arg.startsWith('@'))?.slice(1) ?? ''
        expect(readFileSync(promptPath)).toEqual(Buffer.from(`\uFEFF${prompt}`))
        return child
      })
    }
    const result = await state.deps.generate(record, 'Repair login')
    if (name) {
      expect(result).toEqual({ name })
    } else {
      expect(result).toMatchObject({ error: expect.stringContaining(error ?? '') })
      expect(result).not.toHaveProperty('name')
      if (provider === 'pi') {
        expect(result).toMatchObject({ failureOutput: { exitCode: 1, stdout, stderr } })
      }
    }
    expect(boundary.spawn).toHaveBeenCalledOnce()
    const spawn = boundary.spawn.mock.calls[0]?.[0]
    // Delivery follows the common spec; the empty OMP recording remains a negative output control.
    expect(spawn).toMatchObject({
      binary: spec.binary,
      args: spec.buildArgs({
        prompt: spec.promptDelivery === 'file' ? `@${promptPath}` : prompt,
        model: provider === 'pi' ? 'openai/gpt-6.1-sol' : 'default'
      }),
      cwd: '/workspace/folder',
      stdinMode: 'pipe'
    })
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(
      spec.promptDelivery === 'stdin' ? prompt : undefined
    )
    if (spec.promptDelivery === 'file') {
      expect(spawn?.args).not.toContain(prompt)
      await vi.waitFor(() => expect(existsSync(dirname(promptPath))).toBe(false))
    }
    if (provider === 'opencode' || provider === 'opencode2') {
      expect(spawn?.env).toMatchObject({
        XDG_DATA_HOME: '/profiles/recorded/data',
        XDG_STATE_HOME: '/profiles/recorded/state',
        OPENCODE_AUTH_CONTENT: undefined
      })
      expect(boundary.account).toHaveBeenCalledWith('opencode', 'recorded')
      // The v2 recording used standalone/argv; these assertions separately cover today's launch.
      expect(spawn?.args).toEqual(['run', '--agent', 'build', '--format', 'json'])
    } else {
      expect(spawn?.env?.PI_CODING_AGENT_DIR).toBe('/recorded/pi')
    }
    expect(boundary.native).not.toHaveBeenCalled()
    if (provider === 'pi') {
      source.actions = { conversationName: { agentId: 'pi' } }
      boundary.spawn.mockClear()
      const explicit = reply(stdout, stderr, exitCode)
      expect(await state.deps.generate(record, 'Repair login')).toEqual(result)
      expect(boundary.spawn.mock.calls[0]?.[0]).toMatchObject({
        binary: spawn?.binary,
        args: spawn?.args,
        env: { PI_CODING_AGENT_DIR: '/configured/pi' }
      })
      expect(explicit.stdin.end.mock.calls).toEqual(child.stdin.end.mock.calls)
    }
  }
)

it.each([100, 1000])(
  'bounds actual eligible and skipped naming catalog work for %i rows',
  async (size) => {
    const state = rig()
    const source = savedChatNamingCatalog(size)
    state.settings.sourceControlAi = source
    const { work, reset } = observeChatNamingCatalogWork()
    const samples: Record<string, typeof work> = {}
    const record = agentSessionRecordFixture()
    const recipes: (SourceControlActionRecipe | undefined)[] = [
      undefined,
      { agentId: 'claude' },
      { agentArgs: '--model fast' },
      { agentId: null, agentArgs: '--model fast' }
    ]
    for (const [index, recipe] of recipes.entries()) {
      source.agentId = index === 0 ? null : 'claude'
      source.actions = recipe ? { conversationName: recipe } : {}
      boundary.spawn.mockClear()
      reply('Catalog title')
      reset()
      expect(await state.deps.generate(record, 'Repair login')).toEqual({ name: 'Catalog title' })
      expect(work.copiedRows).toBeLessThanOrEqual(3 * size)
      expect(work.copiedRows).toBeGreaterThanOrEqual(size)
      expect(work.copiedBytes).toBeLessThanOrEqual(3 * 64 * size)
      expect(work.copiedBytes).toBeGreaterThanOrEqual(32 * size)
      expect(work.selectedRowReads).toBeLessThanOrEqual(2 * size + 2)
      expect(work.selectedRowReads).toBeGreaterThanOrEqual(index === 3 ? 0 : size)
      const agent = index === 3 ? 'codex' : 'claude'
      expect(boundary.spawn).toHaveBeenCalledOnce()
      expect(boundary.spawn.mock.calls[0]?.[0].binary).toBe(agent)
      if (index > 1) {
        expect(boundary.spawn.mock.calls[0]?.[0].args).toEqual(
          expect.arrayContaining(['--model', 'fast'])
        )
      }
      if (index === 0) {
        expect(boundary.spawn.mock.calls[0]?.[0].env?.CLAUDE_CONFIG_DIR).toBe('/home/user/.claude')
      }
      samples[`cli-${index}`] = { ...work }
    }
    source.actions = {}
    source.agentId = null
    record.provider = 'grok'
    record.accountHome = { variable: 'GROK_HOME', path: '/recorded/grok' }
    nativeReply()
    reset()
    expect(await state.deps.generate(record, 'Repair login')).toEqual({ name: 'Native title' })
    expect(work.copiedRows).toBeLessThanOrEqual(2 * size)
    expect(work.copiedRows).toBeGreaterThanOrEqual(size)
    expect(work.copiedBytes).toBeLessThanOrEqual(2 * 64 * size)
    expect(work.selectedRowReads).toBe(0)
    expect(boundary.native).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'grok', accountHome: record.accountHome })
    )
    samples.native = { ...work }
    for (const kind of ['remote', 'wsl']) {
      if (kind === 'wsl') {
        record.location.wslDistro = 'Ubuntu'
      }
      state.runtime.resolveWorkspace.mockResolvedValue({
        path: '/remote',
        executionHostId: kind === 'remote' ? toSshExecutionHostId('target') : 'local'
      })
      boundary.spawn.mockClear()
      boundary.native.mockClear()
      reset()
      expect(await state.deps.generate(record, 'Repair login')).toBeNull()
      expect(work).toEqual({ copiedRows: 0, copiedBytes: 0, selectedRowReads: 0 })
      expect(boundary.spawn).not.toHaveBeenCalled()
      expect(boundary.native).not.toHaveBeenCalled()
      samples[kind] = { ...work }
    }
    console.log(JSON.stringify({ metric: 'chat-naming-runtime-catalog', size, samples }))
  }
)
