import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { savedChatNamingCatalog } from '../../../../shared/chat-naming-catalog-work.test-fixture'
import type { SpawnSourceControlAgent } from '../../../text-generation/source-control-text-generation-types'
import { createMockDiscoveryChild } from '../../../text-generation/commit-message-text-generation-test-harness'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import recordings from '../../__fixtures__/chat-naming-recorded-output.json'
import type * as OwnedOpenCodeTask from '../../../opencode/opencode-owned-text-task'

const boundary = vi.hoisted(() => ({
  spawn: vi.fn<SpawnSourceControlAgent>(),
  native: vi.fn<NonNullable<StructuredAgentSessionAdapter['generateText']>>(),
  openCode: vi.fn(
    async (_input: { cwd: string; env?: NodeJS.ProcessEnv; prompt: string }) => 'Owned title'
  ),
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  }))
}))
vi.mock('../../../opencode/opencode-owned-text-task', async (importOriginal) => ({
  ...(await importOriginal<typeof OwnedOpenCodeTask>()),
  runOwnedOpenCodeTextTask: boundary.openCode
}))
vi.mock('../../../text-generation/source-control-agent-launch', () => ({
  spawnSourceControlAgent: boundary.spawn
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: { generateText: boundary.native } } })
}))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: boundary.account
  })
}))
beforeEach(() => {
  vi.clearAllMocks()
  boundary.spawn.mockReset()
  boundary.native.mockReset()
  boundary.openCode.mockClear()
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

it.each(recordings.filter((capture) => capture.provider === 'pi' || capture.provider === 'omp'))(
  'consumes recorded $provider output through runtime, request, planner and parser',
  async (capture) => {
    const { provider, stdout, stderr, exitCode, name, error } = capture
    if (!isTuiAgent(provider)) {
      throw new Error('Unknown recorded provider')
    }
    const state = rig()
    const source = state.settings.sourceControlAi
    if (!source) {
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
    record.accountHome = { variable: 'PI_CODING_AGENT_DIR', path: '/recorded/pi' }
    const usesFilePrompt = provider === 'omp'
    const child = reply(stdout, stderr, exitCode)
    let promptPath = ''
    if (usesFilePrompt) {
      boundary.spawn.mockImplementationOnce((input) => {
        promptPath = input.args.find((arg) => arg.startsWith('@'))?.slice(1) ?? ''
        expect(readFileSync(promptPath, 'utf8')).toContain('Repair login')
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
    expect(spawn).toMatchObject({
      binary: usesFilePrompt ? 'omp' : 'pi',
      cwd: '/workspace/folder',
      stdinMode: 'pipe'
    })
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(
      usesFilePrompt ? undefined : expect.stringContaining('Repair login')
    )
    if (usesFilePrompt) {
      expect(spawn?.args.some((arg) => arg.includes('Repair login'))).toBe(false)
      await vi.waitFor(() => expect(existsSync(dirname(promptPath))).toBe(false))
    }
    expect(spawn?.env?.PI_CODING_AGENT_DIR).toBe('/recorded/pi')
    expect(boundary.native).not.toHaveBeenCalled()
    if (provider === 'pi') {
      const modelIndex = spawn?.args.indexOf('--model') ?? -1
      expect(spawn?.args.slice(modelIndex, modelIndex + 2)).toEqual([
        '--model',
        'openai/gpt-6.1-sol'
      ])
      source.actions = { conversationName: { agentId: 'pi' } }
      boundary.spawn.mockClear()
      const explicit = reply(stdout, stderr, exitCode)
      expect(await state.deps.generate(record, 'Repair login')).toEqual(result)
      const explicitSpawn = boundary.spawn.mock.calls[0]?.[0]
      expect(explicitSpawn).toMatchObject({
        binary: 'pi',
        env: { PI_CODING_AGENT_DIR: '/configured/pi' }
      })
      const explicitModelIndex = explicitSpawn?.args.indexOf('--model') ?? -1
      expect(explicitSpawn?.args.slice(explicitModelIndex, explicitModelIndex + 2)).toEqual([
        '--model',
        'openai/gpt-6.1-sol'
      ])
      expect(explicit.stdin.end).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Repair login')
      )
    }
  }
)

it.each(['opencode', 'opencode2'] as const)(
  'routes %s naming into the owned task with its selected account',
  async (provider) => {
    const state = rig()
    const record = agentSessionRecordFixture()
    record.provider = provider
    record.accountHome = {
      kind: 'opencode',
      locator: { kind: 'managed', managedProfileId: 'recorded' }
    }
    expect(await state.deps.generate(record, 'Repair login')).toEqual({ name: 'Owned title' })
    expect(boundary.openCode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace/folder',
        prompt: expect.stringContaining('Repair login'),
        env: expect.objectContaining({
          XDG_DATA_HOME: '/profiles/recorded/data',
          XDG_STATE_HOME: '/profiles/recorded/state',
          OPENCODE_AUTH_CONTENT: undefined
        })
      })
    )
    expect(boundary.spawn).not.toHaveBeenCalled()
    expect(boundary.account).toHaveBeenCalledWith('opencode', 'recorded')
  }
)

it('reports unsupported Gemini CLI naming without selecting another agent', async () => {
  const state = rig()
  const record = agentSessionRecordFixture()
  record.provider = 'gemini'
  record.accountHome = { variable: 'GEMINI_CLI_HOME', path: '/pinned-account' }
  expect(await state.deps.generate(record, 'Repair login')).toMatchObject({
    error: expect.stringContaining('Agent "gemini" does not support chat names.')
  })
  expect(boundary.spawn).not.toHaveBeenCalled()
  expect(boundary.native).not.toHaveBeenCalled()
  expect(boundary.openCode).not.toHaveBeenCalled()
})
