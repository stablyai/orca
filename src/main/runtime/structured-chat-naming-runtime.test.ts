import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { normalizeSourceControlAiSettings } from '../../shared/source-control-ai-settings'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type * as TextGeneration from '../text-generation/commit-message-text-generation'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ success: true as const, name: 'Login repair' })),
  target: vi.fn(async (cwd: string) => ({ kind: 'local' as const, cwd })),
  publishConversationName: vi.fn<(sessionId: string) => void>()
}))

vi.mock('../text-generation/commit-message-text-generation', async (importOriginal) => {
  const actual = await importOriginal<typeof TextGeneration>()
  return { ...actual, generateConversationNameFromContext: mocks.generate }
})
vi.mock('../agent-hooks/first-work-generation-target', () => ({
  resolveGenerationTarget: mocks.target
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    publishConversationName: mocks.publishConversationName
  })
}))

beforeEach(() => vi.clearAllMocks())

function rig() {
  const settings = getDefaultSettings('/isolated')
  settings.defaultTuiAgent = 'codex'
  settings.sourceControlAi = normalizeSourceControlAiSettings(settings.sourceControlAi)
  const runtime = {
    resolveWorkspace: vi.fn(async () => ({
      path: '/workspace/folder',
      executionHostId: 'local' as const
    })),
    getAgentEnvResolvers: vi.fn(() => undefined),
    hasOpenDispatch: vi.fn(() => false),
    retitleOpenTab: vi.fn()
  }
  const logger = { warn: vi.fn(), error: vi.fn() }
  return {
    settings,
    runtime,
    logger,
    deps: structuredChatNamingDeps(() => ({ getSettings: () => settings }), runtime, logger)
  }
}

describe('structured chat naming runtime', () => {
  it('defers the settings store lookup until naming needs it', () => {
    const state = rig()
    const unavailableStore = vi.fn(() => {
      throw new Error('runtime_unavailable')
    })
    const deps = structuredChatNamingDeps(unavailableStore, state.runtime, state.logger)
    expect(unavailableStore).not.toHaveBeenCalled()
    expect(() => deps.getSettings()).toThrow('runtime_unavailable')
  })

  it('re-reads the selected agent and template for the next chat', async () => {
    const state = rig()
    await state.deps.generate(agentSessionRecordFixture(), 'Repair login')
    expect(mocks.generate).toHaveBeenLastCalledWith(
      { firstPrompt: 'Repair login' },
      expect.objectContaining({ agentId: 'codex' }),
      { kind: 'local', cwd: '/workspace/folder' }
    )
    state.settings.sourceControlAi = {
      ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
      actions: {
        conversationName: {
          agentId: 'claude',
          commandInputTemplate: 'Short name for {firstPrompt}',
          agentArgs: '--model haiku'
        }
      }
    }
    await state.deps.generate(agentSessionRecordFixture(), 'Repair another chat')
    expect(mocks.generate).toHaveBeenLastCalledWith(
      { firstPrompt: 'Repair another chat' },
      expect.objectContaining({
        agentId: 'claude',
        commandInputTemplate: 'Short name for {firstPrompt}',
        agentArgs: '--model haiku'
      }),
      expect.anything()
    )
  })

  it('resolves plain folder workspaces without requiring a git repository', async () => {
    const state = rig()
    const record = agentSessionRecordFixture()
    record.location.workspaceKind = 'folder'
    expect(await state.deps.generate(record, 'Repair login')).toBe('Login repair')
    expect(state.runtime.resolveWorkspace).toHaveBeenCalledWith(record.location.workspaceId)
    expect(mocks.target).toHaveBeenCalledWith('/workspace/folder', 'codex', null, state.runtime)
  })

  it('refuses an SSH workspace instead of spawning on the client', async () => {
    const state = rig()
    const remote = structuredChatNamingDeps(
      () => ({ getSettings: () => state.settings }),
      {
        ...state.runtime,
        resolveWorkspace: async () => ({
          path: '/remote/workspace',
          executionHostId: toSshExecutionHostId('target')
        })
      },
      state.logger
    )
    await expect(remote.generate(agentSessionRecordFixture(), 'Repair login')).rejects.toThrow(
      'not this native execution host'
    )
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('publishes a new name to the host feed and retitles the open tab', () => {
    const state = rig()
    state.deps.onNamed('workspace-1', 'session-1')
    expect(mocks.publishConversationName).toHaveBeenCalledWith('session-1')
    expect(state.runtime.retitleOpenTab).toHaveBeenCalledWith('workspace-1', 'session-1')
  })

  it('still retitles the open tab when the feed publication fails', () => {
    const state = rig()
    mocks.publishConversationName.mockImplementationOnce(() => {
      throw new Error('journal unreadable')
    })
    state.deps.onNamed('workspace-1', 'session-1')
    expect(state.runtime.retitleOpenTab).toHaveBeenCalledWith('workspace-1', 'session-1')
    expect(state.logger.warn).toHaveBeenCalledWith(
      'Chat name publication failed',
      expect.objectContaining({ sessionId: 'session-1' })
    )
  })

  it('declines invalid agent configuration without launching anything', async () => {
    const state = rig()
    state.settings.sourceControlAi = {
      ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
      actions: { conversationName: { agentId: 'custom' } },
      customAgentCommand: ''
    }
    expect(await state.deps.generate(agentSessionRecordFixture(), 'Repair login')).toBeNull()
    expect(state.logger.warn).toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
