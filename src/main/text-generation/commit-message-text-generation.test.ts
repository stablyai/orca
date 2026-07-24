/* eslint-disable max-lines -- Why: local/remote generation, cancellation, and
   env propagation share subprocess mocks; splitting would obscure the
   cross-path invariants these tests protect. */
import { exec, spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { sourceControlAiSettingsFromLegacy } from '../../shared/source-control-ai'
import type { GlobalSettings } from '../../shared/types'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  generateBranchNameFromContext,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS,
  resolveCommitMessageSettings,
  trimGeneratedCommitMessage
} from './commit-message-text-generation'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    exec: vi.fn((_command, callback) => {
      if (typeof callback === 'function') {
        callback(null, '', '')
      }
      return new actual.ChildProcess()
    }),
    spawn: vi.fn(actual.spawn)
  }
})

const execMock = vi.mocked(exec)
const spawnMock = vi.mocked(spawn)

type MockDiscoveryChild = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
}

function createMockDiscoveryChild(): MockDiscoveryChild {
  const child = new EventEmitter() as MockDiscoveryChild
  child.pid = 123
  child.kill = vi.fn()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  return child
}

function syncSourceControlAiFromLegacy(settings: GlobalSettings): void {
  settings.sourceControlAi = sourceControlAiSettingsFromLegacy(settings.commitMessageAi)
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

function expectChildTerminated(child: { pid: number; kill: ReturnType<typeof vi.fn> }): void {
  if (process.platform === 'win32') {
    expect(execMock).toHaveBeenCalledWith(`taskkill /pid ${child.pid} /T /F`, expect.any(Function))
    expect(child.kill).not.toHaveBeenCalled()
    return
  }
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
}

beforeEach(() => {
  execMock.mockClear()
  spawnMock.mockClear()
})

describe('resolveCommitMessageSettings', () => {
  it('falls back when a dynamic persisted model was not discovered', () => {
    const settings = getDefaultSettings('/tmp')
    settings.enableGitHubAttribution = true
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'retired-model' },
      selectedThinkingByModel: {},
      customPrompt: 'Use Conventional Commits.',
      customAgentCommand: ''
    }
    settings.sourceControlAi = undefined

    const result = resolveCommitMessageSettings(settings)

    expect(result).toEqual({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'low',
        customPrompt: 'Use Conventional Commits.',
        commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.'
      }
    })
  })

  it('falls back from stale Claude version ids to the CLI alias default', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'claude',
      selectedModelByAgent: { claude: 'claude-sonnet-4-6' },
      selectedThinkingByModel: { sonnet: 'low' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'claude',
        model: 'sonnet',
        thinkingLevel: 'low'
      }
    })
  })

  it("uses the user's default agent when the AI setting has no explicit agent", () => {
    const settings = getDefaultSettings('/tmp')
    settings.defaultTuiAgent = 'codex'

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'low'
      }
    })
  })

  it('preserves dynamic persisted models that were discovered by the CLI', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'gpt-5.2' },
      discoveredModelsByAgent: {
        cursor: [
          {
            id: 'gpt-5.2',
            label: 'GPT 5.2',
            thinkingLevels: [{ id: 'xhigh', label: 'Extra High' }],
            defaultThinkingLevel: 'xhigh'
          }
        ]
      },
      selectedThinkingByModel: { 'gpt-5.2': 'xhigh' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'gpt-5.2',
        thinkingLevel: 'xhigh'
      }
    })
  })

  it('uses host-scoped discovered models for SSH worktrees', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'auto' },
      selectedModelByAgentByHost: { 'ssh:conn-1': { cursor: 'remote-only' } },
      discoveredModelsByAgent: { cursor: [{ id: 'auto', label: 'Auto' }] },
      discoveredModelsByAgentByHost: {
        'ssh:conn-1': { cursor: [{ id: 'remote-only', label: 'Remote Only' }] }
      },
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings, 'ssh:conn-1')

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'remote-only'
      }
    })
  })

  it('falls back to the model default thinking level when a persisted level is stale', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4-mini' },
      selectedThinkingByModel: { 'gpt-5.4-mini': 'turbo' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        thinkingLevel: 'low'
      }
    })
  })

  it('passes the per-agent command override into non-interactive planning', () => {
    const settings = getDefaultSettings('/tmp')
    settings.agentCmdOverrides.codex = 'npx codex'
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4-mini' },
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'codex',
        agentCommandOverride: 'npx codex'
      }
    })
  })

  it('falls back when persisted thinking belongs to an undiscovered dynamic model', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'cursor',
      selectedModelByAgent: { cursor: 'gpt-5.2' },
      selectedThinkingByModel: { 'gpt-5.2': 'xhigh' },
      customPrompt: '',
      customAgentCommand: ''
    }
    syncSourceControlAiFromLegacy(settings)

    const result = resolveCommitMessageSettings(settings)

    expect(result).toMatchObject({
      ok: true,
      params: {
        agentId: 'cursor',
        model: 'auto'
      }
    })
  })

  it('requires a non-empty custom command for custom agents', () => {
    const settings = getDefaultSettings('/tmp')
    settings.commitMessageAi = {
      enabled: true,
      agentId: 'custom',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: '   '
    }
    syncSourceControlAiFromLegacy(settings)

    expect(resolveCommitMessageSettings(settings)).toEqual({
      ok: false,
      error: 'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
    })
  })
})

describe('discoverCommitMessageModelsLocal', () => {
  it('returns static catalog models without spawning for static agents', async () => {
    const result = await discoverCommitMessageModelsLocal('amp', undefined)

    expect(result).toMatchObject({
      success: true,
      defaultModelId: 'smart'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('discovers dynamic models through the agent CLI', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\ngpt-5.2 - GPT-5.2\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.2', label: 'GPT-5.2' }
      ]
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'cursor-agent',
      ['--list-models'],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it('discovers dynamic models through the configured agent command override', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined, 'npx cursor-agent')

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto'
    })
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/c', expect.stringMatching(/npx\.cmd$/i), 'cursor-agent', '--list-models'],
        expect.objectContaining({ windowsHide: true })
      )
    } else {
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['cursor-agent', '--list-models'],
        expect.objectContaining({ windowsHide: true })
      )
    }
  })

  it('discovers dynamic models through the selected WSL distro login shell', async () => {
    await withPlatform('win32', async () => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = discoverCommitMessageModelsLocal('cursor', undefined, undefined, {
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      })

      listeners.get('stdout:data')?.(Buffer.from('auto - Auto\n'))
      listeners.get('close')?.(0)

      await expect(pending).resolves.toMatchObject({
        success: true,
        defaultModelId: 'auto'
      })
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'sh', '-lc', expect.any(String)],
        expect.objectContaining({
          cwd: undefined,
          windowsHide: true
        })
      )
      const shellCommand = spawnMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain('/mnt/c/repo')
      expect(shellCommand).toContain("'cursor-agent'")
      expect(shellCommand).toContain('--list-models')
    })
  })

  it('falls back to static models when dynamic discovery returns no parseable models', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stdout:data')?.(Buffer.from('provider model\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'github-copilot/gpt-5.4-mini',
      models: [{ id: 'github-copilot/gpt-5.4-mini' }]
    })
  })

  it('parses Pi model discovery from stderr when the CLI exits successfully', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stderr:data')?.(
      Buffer.from(
        [
          'provider        model                   context  max-out  thinking  images',
          'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
          'openai-codex    gpt-5.5                 272K     128K     yes       yes'
        ].join('\n')
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'github-copilot/gpt-5.4-mini',
      models: [{ id: 'github-copilot/gpt-5.4-mini' }, { id: 'openai-codex/gpt-5.5' }]
    })
  })

  it('shares one child process for concurrent identical model discovery', async () => {
    const children: MockDiscoveryChild[] = []
    spawnMock.mockImplementation(() => {
      const child = createMockDiscoveryChild()
      children.push(child)
      return child as never
    })

    const first = discoverCommitMessageModelsLocal('cursor', { TOKEN: 'secret' })
    const second = discoverCommitMessageModelsLocal('cursor', { TOKEN: 'secret' })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    children[0]!.stdout.emit('data', Buffer.from('auto - Auto\n'))
    children[0]!.emit('close', 0)

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ success: true, defaultModelId: 'auto' })
    expect(secondResult).toEqual(firstResult)

    const retry = discoverCommitMessageModelsLocal('cursor', { TOKEN: 'secret' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    children[1]!.stdout.emit('data', Buffer.from('auto - Auto\n'))
    children[1]!.emit('close', 0)
    await expect(retry).resolves.toEqual(firstResult)
  })

  it('keeps different agent parsers isolated when discovery commands match', async () => {
    const children: MockDiscoveryChild[] = []
    spawnMock.mockImplementation(() => {
      const child = createMockDiscoveryChild()
      children.push(child)
      return child as never
    })

    const cursor = discoverCommitMessageModelsLocal('cursor', undefined, 'custom-discovery')
    const pi = discoverCommitMessageModelsLocal('pi', undefined, 'custom-discovery')

    expect(children).toHaveLength(2)
    children[0]!.stdout.emit('data', Buffer.from('auto - Auto\n'))
    children[0]!.emit('close', 0)
    children[1]!.stderr.emit(
      'data',
      Buffer.from(
        [
          'provider        model                   context  max-out  thinking  images',
          'github-copilot  gpt-5.4-mini            400K     128K     yes       yes'
        ].join('\n')
      )
    )
    children[1]!.emit('close', 0)

    await expect(cursor).resolves.toMatchObject({ success: true, defaultModelId: 'auto' })
    await expect(pi).resolves.toMatchObject({
      success: true,
      defaultModelId: 'github-copilot/gpt-5.4-mini'
    })
  })

  it('shares the local process cap across discovery and generation, then releases on close', async () => {
    const children: MockDiscoveryChild[] = []
    spawnMock.mockImplementation(() => {
      const child = createMockDiscoveryChild()
      child.pid += children.length
      children.push(child)
      return child as never
    })
    const active = Array.from({ length: MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS }, (_, index) =>
      discoverCommitMessageModelsLocal('cursor', undefined, undefined, {
        cwd: `/repo-${index}`
      })
    )

    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)
    await expect(
      discoverCommitMessageModelsLocal('cursor', undefined, undefined, {
        cwd: '/repo-overflow'
      })
    ).resolves.toEqual({
      success: false,
      error:
        'Too many local AI generations are already running. Wait for one to finish and try again.'
    })
    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
        { agentId: 'custom', model: '', customAgentCommand: 'agent' },
        { kind: 'local', cwd: '/generation-overflow' }
      )
    ).resolves.toEqual({
      success: false,
      error:
        'Too many local AI generations are already running. Wait for one to finish and try again.'
    })
    expect(spawnMock).toHaveBeenCalledTimes(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)

    children[0]!.stdout.emit('data', Buffer.from('auto - Auto\n'))
    children[0]!.emit('close', 0)
    await active[0]

    const retry = discoverCommitMessageModelsLocal('cursor', undefined, undefined, {
      cwd: '/repo-overflow'
    })
    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS + 1)

    for (const child of children.slice(1)) {
      child.stdout.emit('data', Buffer.from('auto - Auto\n'))
      child.emit('close', 0)
    }
    await expect(Promise.all([...active, retry])).resolves.toHaveLength(
      MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS + 1
    )
  })

  it('settles and detaches model discovery when timeout kill is ignored', async () => {
    vi.useFakeTimers()
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)

    try {
      const pending = discoverCommitMessageModelsLocal('cursor', undefined)
      const assertion = expect(pending).resolves.toMatchObject({
        success: false,
        error: 'Cursor model discovery timed out after 60s.'
      })

      await vi.advanceTimersByTimeAsync(60_000)

      await assertion
      expectChildTerminated(child)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(1)
      child.emit('close', null)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles and detaches model discovery when output exceeds the limit', async () => {
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1))

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'Cursor returned too much model data.'
    })
    expectChildTerminated(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(1)
    child.emit('close', null)
    expect(child.listenerCount('close')).toBe(0)
  })
})

describe('generateCommitMessageFromContext', () => {
  it('discovers dynamic models through a remote execution plan', async () => {
    const execute = vi.fn(async (plan, cwd, timeoutMs) => {
      expect(plan).toEqual({
        binary: 'npx',
        args: ['cursor-agent', '--list-models'],
        stdinPayload: null,
        label: 'Cursor'
      })
      expect(cwd).toBe('/remote/repo')
      expect(timeoutMs).toBe(60_000)
      return {
        stdout: 'auto - Auto\ngpt-5.2 - GPT-5.2\n',
        stderr: '',
        exitCode: 0,
        timedOut: false
      }
    })

    const result = await discoverCommitMessageModelsRemote(
      'cursor',
      '/remote/repo',
      execute,
      'npx cursor-agent'
    )

    expect(result).toMatchObject({
      success: true,
      defaultModelId: 'auto',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.2', label: 'GPT-5.2' }
      ]
    })
  })

  it('reports remote model discovery spawn failures with remote install guidance', async () => {
    const result = await discoverCommitMessageModelsRemote('cursor', '/remote/repo', async () => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: 'ENOENT'
    }))

    expect(result).toEqual({
      success: false,
      error: 'cursor-agent not found on the remote PATH. Install Cursor there.'
    })
  })

  it('uses a prepared remote execution plan instead of running git on the remote side', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent --message {prompt}'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan, cwd, timeoutMs) => {
          expect(cwd).toBe('/repo')
          expect(timeoutMs).toBe(60_000)
          expect(plan.binary).toBe('agent')
          expect(plan.args).toHaveLength(2)
          expect(plan.args[0]).toBe('--message')
          expect(plan.args[1]).toContain('Staged files:\nM\tREADME.md')
          return {
            stdout: 'Add README note.\n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(result).toEqual({
      success: true,
      message: 'Add README note',
      agentLabel: 'agent'
    })
  })

  it('exposes raw CLI failure output only after path sanitization', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'You are generating a single git commit message for /secret/repo',
          stderr: 'raw failure output with /Users/thebr/My Repo/secret/file.ts',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: raw failure output with [path]'
    })
  })

  it('formats nonzero exit failures with extracted sanitized CLI details', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'ERROR: fatal: C:\\Users\\Brennan Doe\\secret\\file.ts failed',
          stderr: '',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: fatal: [path] failed'
    })
  })

  it('redacts UNC paths in CLI failure details', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'ERROR: failed at \\\\server\\share\\Brennan Repo\\secret\\file.ts',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: failed at [path]'
    })
  })

  it('reports an empty result with the stderr excerpt when exit 0 produces no stdout', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '\u001b[91m\u001b[1mError: \u001b[0mNo payment method',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty message. CLI output: Error: No payment method'
    })
  })

  it('surfaces pi auth failure detail end-to-end through the adjusted path sanitizer', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: [
            'No API key found for github-copilot.',
            '',
            'Use /login to log into a provider via OAuth or API key. See:',
            '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
            '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/models.md'
          ].join('\n'),
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'Pi CLI command failed with code 1: No API key found for github-copilot. Use /login to log into a provider via OAuth or API key. See: … [path]'
    })
  })

  it('preserves slash-commands while redacting multi-segment paths in failure detail', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'ERROR: run /login then check /Users/name/repo',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: ERROR: run /login then check [path]'
    })
  })

  it('redacts a filesystem path embedded in a pi HTTP 401 payload', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"Invalid key loaded from /Users/name/.config/pi/auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"Invalid key loaded from [path]"}'
    })
  })

  it('redacts a Windows drive path with JSON-escaped backslashes in a payload', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"Invalid key loaded from C:\\\\Users\\\\name\\\\auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"Invalid key loaded from [path]"}'
    })
  })

  it('keeps a scheme:// remedy URL intact while still redacting paths', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr:
            '401: Visit https://console.anthropic.com/settings/keys then check /Users/name/.config/pi/auth.json',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'Pi CLI command failed with code 1: 401: Visit https://console.anthropic.com/settings/keys then check [path]'
    })
  })

  it('redacts key=/path shapes in provider bodies', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: '401: {"message":"rejected credential_path=/Users/name/.config/pi/auth.json"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Pi CLI command failed with code 1: 401: {"message":"rejected credential_path=[path]"}'
    })
  })

  it.each([
    [
      'comma-prefixed list path',
      '401: {"message":"candidate list a,/Users/name/creds rejected"}',
      'Pi CLI command failed with code 1: 401: {"message":"candidate list a,[path] rejected"}'
    ],
    [
      'non-drive colon-prefixed path',
      '401: {"message":"slot 1:/Users/name/alt failed"}',
      'Pi CLI command failed with code 1: 401: {"message":"slot 1:[path] failed"}'
    ]
  ])('redacts a %s in provider bodies', async (_shape, stderr, expected) => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr,
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({ success: false, error: expected })
  })

  it('passes the live colonless 400 gateway payload through the sanitizer unmangled', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr:
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CcsZLJ5ZiLLNvpxcxDuU4"}',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result.success).toBe(false)
    if (result.success) {
      throw new Error('expected a failure result')
    }
    expect(result.error.startsWith('Pi CLI command failed with code 1: 400 {"type":"error"')).toBe(
      true
    )
    // The bare domain link survives path redaction so the remedy stays usable.
    expect(result.error).toContain('claude.ai/settings/usage')
    expect(result.error.length).toBeLessThanOrEqual(300)
  })

  it('preserves the structured subject and body when formatting the final response', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Update README.\n\n- Explain the generated commit-message flow\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      message: 'Update README\n\n- Explain the generated commit-message flow',
      agentLabel: 'agent'
    })
  })

  it('reports empty remote commit-message output as an empty message', async () => {
    let operation = ''
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('commit-message')
    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty message.'
    })
  })

  it('sanitizes remote execution transport failures', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => {
          throw new Error('relay disconnected while reading /secret/repo')
        }
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'agent could not be reached on the remote PATH. Try again after the SSH connection recovers.'
    })
  })

  it('caps local agent output before buffering unbounded data', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    listeners.get('stdout:data')?.(Buffer.alloc(4 * 1024 * 1024 + 1))
    listeners.get('close')?.(null)

    await expect(pending).resolves.toEqual({
      success: false,
      error:
        'agent CLI command produced too much output. Check the agent CLI configuration and try again.'
    })
    expectChildTerminated(child)
  })

  it('preserves local agent output delivered as 100,000 one-byte fragments', async () => {
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)
    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      { kind: 'local', cwd: '/fragmented-repo' }
    )

    for (let index = 0; index < 100_000; index += 1) {
      child.stdout.emit('data', Buffer.from(' '))
    }
    child.stdout.emit('data', Buffer.from('Update README\n'))
    child.emit('close', 0)

    await expect(pending).resolves.toEqual({
      success: true,
      message: 'Update README',
      agentLabel: 'agent'
    })
  })

  it('passes prepared provider environment to local agent subprocesses', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'orca-test-agent-nope'
      },
      {
        kind: 'local',
        cwd: '/repo',
        env: { ...process.env, CODEX_HOME: '/managed/codex-home' }
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('Add README note\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      message: 'Add README note'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'orca-test-agent-nope',
      [],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('routes WSL local commit generation through the selected distro login shell', async () => {
    await withPlatform('win32', async () => {
      process.env.ORCA_HOST_ONLY_SECRET = 'do-not-leak'
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'agent --mode fast'
        },
        {
          kind: 'local',
          cwd: 'C:\\repo',
          wslDistro: 'Ubuntu 24.04',
          env: { ...process.env, CODEX_HOME: '/home/tester/.codex' }
        }
      )

      listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
      listeners.get('close')?.(0)

      await expect(pending).resolves.toMatchObject({
        success: true,
        message: 'Update README'
      })
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu 24.04', '--', 'sh', '-lc', expect.any(String)],
        expect.objectContaining({
          cwd: undefined,
          windowsHide: true,
          env: expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' })
        })
      )
      const spawnEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
      expect(spawnEnv.ORCA_HOST_ONLY_SECRET).toBeUndefined()
      const shellCommand = spawnMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain('exec "\\$_orca_wsl_shell" -ilc')
      expect(shellCommand).toContain('/mnt/c/repo')
      expect(shellCommand).toContain("'agent'")
      expect(shellCommand).toContain('--mode')
      expect(shellCommand).toContain('fast')
    })
  })

  it('keeps local commit-message and pull-request cancellation lanes separate', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners })
      return child as never
    })

    const commit = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )
    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGenerateCommitMessageLocal('/repo')

    expectChildTerminated(children[0]!)
    expect(children[1]?.kill).not.toHaveBeenCalled()

    children[0]?.listeners.get('close')?.(null)
    const pullRequestStdout = children[1]?.listeners.get('stdout:data')
    pullRequestStdout?.(
      Buffer.from('{"base":"main","title":"Update README","body":"Details","draft":false}')
    )
    children[1]?.listeners.get('close')?.(0)

    await expect(commit).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    await expect(pullRequest).resolves.toMatchObject({
      success: true,
      fields: {
        base: 'main',
        title: 'Update README',
        body: 'Details',
        draft: false
      }
    })

    cancelGeneratePullRequestFieldsLocal('/repo')
    expect(children[1]?.kill).not.toHaveBeenCalled()
  })

  it('cancels the previous process before replacing one local lane', async () => {
    const children: {
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ kill: child.kill, listeners })
      return child as never
    })
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'custom' as const, model: '', customAgentCommand: 'agent' }
    const target = { kind: 'local' as const, cwd: '/same-repo' }

    const first = generateCommitMessageFromContext(context, params, target)
    const second = generateCommitMessageFromContext(context, params, target)

    expectChildTerminated({ pid: 123, kill: children[0]!.kill })
    expect(children).toHaveLength(2)
    children[0]?.listeners.get('close')?.(null)
    children[1]?.listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
    children[1]?.listeners.get('close')?.(0)
    await expect(first).resolves.toMatchObject({ success: false, canceled: true })
    await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
  })

  it('caps concurrent local text-generation child processes', async () => {
    const children: Map<string, (value: unknown) => void>[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 200 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push(listeners)
      return child as never
    })
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'custom' as const, model: '', customAgentCommand: 'agent' }
    const active = Array.from({ length: MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS }, (_, index) =>
      generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: `/repo-${index}`
      })
    )

    await expect(
      generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: '/repo-overflow'
      })
    ).resolves.toEqual({
      success: false,
      error:
        'Too many local AI generations are already running. Wait for one to finish and try again.'
    })
    expect(spawnMock).toHaveBeenCalledTimes(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)

    for (const listeners of children) {
      listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
      listeners.get('close')?.(0)
    }
    await expect(Promise.all(active)).resolves.toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)
  })

  it('waits for a full-capacity lane to close before spawning its replacement', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
      closed: boolean
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 300 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners, closed: false })
      return child as never
    })
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'custom' as const, model: '', customAgentCommand: 'agent' }
    const active = Array.from({ length: MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS }, (_, index) =>
      generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: `/full-repo-${index}`
      })
    )

    const replacement = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/full-repo-0'
    })

    expectChildTerminated(children[0]!)
    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)
    expect(children.filter((child) => !child.closed)).toHaveLength(
      MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS
    )

    children[0]!.closed = true
    children[0]!.listeners.get('close')?.(null)
    await Promise.resolve()
    await Promise.resolve()

    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS + 1)
    expect(children.filter((child) => !child.closed)).toHaveLength(
      MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS
    )

    for (const child of children.slice(1)) {
      child.listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
      child.closed = true
      child.listeners.get('close')?.(0)
    }
    await expect(active[0]).resolves.toMatchObject({ success: false, canceled: true })
    await expect(Promise.all([...active.slice(1), replacement])).resolves.toHaveLength(
      MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS
    )
  })

  it('cancels and supersedes replacements queued behind a full lane', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 400 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners })
      return child as never
    })
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'custom' as const, model: '', customAgentCommand: 'agent' }
    const active = Array.from({ length: MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS }, (_, index) =>
      generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: `/queued-repo-${index}`
      })
    )

    const superseded = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/queued-repo-0'
    })
    const canceled = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/queued-repo-0'
    })

    await expect(superseded).resolves.toMatchObject({ success: false, canceled: true })
    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)
    cancelGenerateCommitMessageLocal('/queued-repo-0')
    await expect(canceled).resolves.toMatchObject({ success: false, canceled: true })

    const replacement = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/queued-repo-0'
    })
    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS)

    children[0]!.listeners.get('close')?.(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(children).toHaveLength(MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS + 1)

    for (const child of children.slice(1)) {
      child.listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
      child.listeners.get('close')?.(0)
    }
    await expect(active[0]).resolves.toMatchObject({ success: false, canceled: true })
    await expect(Promise.all([...active.slice(1), replacement])).resolves.toHaveLength(
      MAX_CONCURRENT_LOCAL_TEXT_GENERATIONS
    )
  })

  it('keeps local pull-request cancellation from stopping commit-message generation', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners })
      return child as never
    })

    const commit = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )
    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGeneratePullRequestFieldsLocal('/repo')

    expect(children[0]?.kill).not.toHaveBeenCalled()
    expectChildTerminated(children[1]!)

    const commitStdout = children[0]?.listeners.get('stdout:data')
    commitStdout?.(Buffer.from('Update README\n'))
    children[0]?.listeners.get('close')?.(0)
    children[1]?.listeners.get('close')?.(null)

    await expect(commit).resolves.toEqual({
      success: true,
      message: 'Update README',
      agentLabel: 'agent'
    })
    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true,
      branchChangedByPreparation: false
    })
  })

  it('reports empty remote pull-request field output as empty details', async () => {
    let operation = ''
    const result = await generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('pull-request-fields')
    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty details.',
      branchChangedByPreparation: false
    })
  })

  it('reports branch changes when pull request field output cannot be parsed', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    spawnMock.mockReturnValue({
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    } as never)

    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: true,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('not json'))
    listeners.get('close')?.(0)

    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: true
    })
  })

  it('reports branch changes when pull request generation is canceled', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: true,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGeneratePullRequestFieldsLocal('/repo')
    listeners.get('close')?.(null)

    expectChildTerminated(child)
    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true,
      branchChangedByPreparation: true
    })
  })

  it('settles local commit-message cancellation even when the killed child does not close', async () => {
    vi.useFakeTimers()
    try {
      const listeners = new Map<string, (value: unknown) => void>()
      const removeListener = (key: string, callback: (value: unknown) => void): void => {
        if (listeners.get(key) === callback) {
          listeners.delete(key)
        }
      }
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: {
          on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)),
          off: vi.fn((event, callback) => removeListener(`stdout:${event}`, callback))
        },
        stderr: {
          on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)),
          off: vi.fn((event, callback) => removeListener(`stderr:${event}`, callback))
        },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback)),
        off: vi.fn((event, callback) => removeListener(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'agent'
        },
        {
          kind: 'local',
          cwd: '/repo'
        }
      )
      const outcomePromise = pending.then((result) =>
        !result.success && result.canceled ? 'canceled' : 'other'
      )

      cancelGenerateCommitMessageLocal('/repo')
      expectChildTerminated(child)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('canceled')
      expect(listeners.has('stdout:data')).toBe(false)
      expect(listeners.has('stderr:data')).toBe(false)
      expect(listeners.has('error')).toBe(false)
      expect(listeners.has('close')).toBe(true)
      listeners.get('close')?.(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes Windows batch-script agent commands through cmd.exe', async () => {
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      await withPlatform('win32', async () => {
        const listeners = new Map<string, (value: unknown) => void>()
        const child = {
          pid: 123,
          kill: vi.fn(),
          stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
          stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
          stdin: { end: vi.fn() },
          on: vi.fn((event, callback) => listeners.set(event, callback))
        }
        spawnMock.mockReturnValue(child as never)

        const pending = generateCommitMessageFromContext(
          {
            branch: 'main',
            stagedSummary: 'M\tREADME.md',
            stagedPatch: '+hello'
          },
          {
            agentId: 'custom',
            model: '',
            customAgentCommand: 'C:/tools/agent.cmd'
          },
          {
            kind: 'local',
            cwd: 'C:\\repo'
          }
        )

        listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
        listeners.get('close')?.(0)

        await expect(pending).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        expect(spawnMock).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/c', 'C:/tools/agent.cmd'],
          expect.objectContaining({
            cwd: 'C:\\repo',
            windowsHide: true
          })
        )
      })
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('rejects unsafe argv prompts for Windows batch-script agent commands', async () => {
    await withPlatform('win32', async () => {
      const result = await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello & goodbye'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'C:/tools/agent.cmd {prompt}'
        },
        {
          kind: 'local',
          cwd: 'C:\\repo'
        }
      )

      expect(result).toEqual({
        success: false,
        error:
          'C:/tools/agent.cmd cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.'
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})

describe('generateBranchNameFromContext', () => {
  it('sanitizes remote agent output into a short branch slug', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '"Fix/Login Flow now please"\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      slug: 'fix-login-flow-now',
      agentLabel: 'agent'
    })
  })

  it('fails when remote agent output sanitizes to an empty branch slug', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '!!! ___\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'Generated branch name was empty after sanitization.',
      failureOutput: { label: 'agent', exitCode: 0, stdout: '!!! ___', stderr: '' }
    })
  })

  it('carries the full CLI output on failures for the local on-demand view', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'partial',
          stderr: 'No API key found for github-copilot.',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result.success).toBe(false)
    if (result.success) {
      throw new Error('expected a failure result')
    }
    expect(result.failureOutput).toEqual({
      label: 'Pi',
      exitCode: 1,
      stdout: 'partial',
      stderr: 'No API key found for github-copilot.'
    })
  })

  it('does not persist stdout-only branch failure detail that may echo the prompt', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Customer secret in the first prompt' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Customer secret in the first prompt',
          stderr: '',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1.',
      failureOutput: {
        label: 'agent',
        exitCode: 1,
        stdout: 'Customer secret in the first prompt',
        stderr: ''
      }
    })
  })

  it('describes a signal-terminated generator without a null exit code', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'Process killed by host',
          exitCode: null,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'Pi CLI command was terminated before exiting: Process killed by host'
    })
  })

  it('keeps branch-name guidance first without dropping the output contract', async () => {
    let prompt = ''
    await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        customPrompt: 'Prefer auth terminology.',
        commandInputTemplate: 'Prefer auth terminology.\n\n{basePrompt}'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          prompt = plan.stdinPayload ?? ''
          return {
            stdout: 'fix-login-flow\n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(prompt.startsWith('Prefer auth terminology.')).toBe(true)
    expect(prompt).toContain('Prefer auth terminology.')
    expect(prompt).not.toContain('Additional user prompt:')
    expect(prompt).toContain('Generate a short git branch name')
    expect(prompt).toContain('Output ONLY the branch name on a single line')
  })
})

describe('trimGeneratedCommitMessage', () => {
  it('removes trailing whitespace from generated messages', () => {
    const message = trimGeneratedCommitMessage('Update docs\n\n')

    expect(message).toBe('Update docs')
  })
})
