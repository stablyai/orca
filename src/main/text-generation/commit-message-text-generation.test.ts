/* eslint-disable max-lines -- Why: local/remote generation, cancellation, and
   env propagation share subprocess mocks; splitting would obscure the
   cross-path invariants these tests protect. */
import { spawn } from 'child_process'
import type * as ChildProcess from 'child_process'
import { EventEmitter } from 'events'
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
  resolveCommitMessageSettings,
  trimGeneratedCommitMessage
} from './commit-message-text-generation'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

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

beforeEach(() => {
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
        customPrompt: 'Use Conventional Commits.'
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
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['cursor-agent', '--list-models'],
      expect.objectContaining({ windowsHide: true })
    )
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
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
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
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
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

  it('does not fall back to raw agent stdout or stderr on failures', async () => {
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
          stderr: 'raw failure output with /secret/repo',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent failed. Check the agent CLI configuration and try again.'
    })
  })

  it('does not expose extracted agent error details to the renderer', async () => {
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
          stdout: 'ERROR: fatal: /secret/repo/config failed',
          stderr: '',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent failed. Check the agent CLI configuration and try again.'
    })
  })

  it('treats empty stdout plus an error on stderr as an agent failure', async () => {
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
      error: 'agent failed. Check the agent CLI configuration and try again.'
    })
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
      error: 'agent failed. Check the agent CLI configuration and try again.'
    })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
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

  it('keeps local commit-message and pull-request cancellation lanes separate', async () => {
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

    expect(children[0]?.kill).toHaveBeenCalledWith('SIGKILL')
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

  it('keeps local pull-request cancellation from stopping commit-message generation', async () => {
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
    expect(children[1]?.kill).toHaveBeenCalledWith('SIGKILL')

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

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
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
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('canceled')
      expect(listeners.has('stdout:data')).toBe(false)
      expect(listeners.has('stderr:data')).toBe(false)
      expect(listeners.has('error')).toBe(false)
      expect(listeners.has('close')).toBe(false)
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
      error: 'Generated branch name was empty after sanitization.'
    })
  })

  it('includes branch-name custom instructions in the generated prompt', async () => {
    let prompt = ''
    await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        customPrompt: 'Prefer auth terminology.'
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

    expect(prompt).toContain('Additional user instructions:')
    expect(prompt).toContain('Prefer auth terminology.')
  })
})

describe('trimGeneratedCommitMessage', () => {
  it('removes trailing whitespace from generated messages', () => {
    const message = trimGeneratedCommitMessage('Update docs\n\n')

    expect(message).toBe('Update docs')
  })
})
