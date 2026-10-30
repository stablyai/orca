import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { submission as journalSubmission } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { normalizeSourceControlAiSettings } from '../../shared/source-control-ai-settings'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import { STRUCTURED_AGENT_RUNTIME_CATALOG } from './structured-agent-runtime-metadata'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalSnapshot
} from '../../shared/agent-session-journal-types'
import type * as TextGeneration from '../text-generation/commit-message-text-generation'

const mocks = vi.hoisted(() => ({
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  })),
  native: vi.fn(async () => 'Native title'),
  generate: vi.fn(async () => ({ success: true as const, name: 'Login repair' })),
  target: vi.fn(async (cwd: string) => ({ kind: 'local' as const, cwd })),
  publishConversationName: vi.fn<(sessionId: string) => void>(),
  journalSnapshot: vi.fn<(sessionId: string) => Promise<AgentJournalSnapshot>>()
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
    deps: { adapter: { generateText: mocks.native } },
    publishConversationName: mocks.publishConversationName,
    journalSnapshot: mocks.journalSnapshot
  })
}))

vi.mock('../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: mocks.account
  })
}))
const roots: string[] = []
afterEach(async () => {
  installClaudeProfileRouter(undefined)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
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
    resolveNamingEnvironment: vi.fn(async (): Promise<Record<string, string>> => ({
      PATH: '/usr/bin'
    })),
    getAgentEnvResolvers: vi.fn(() => undefined),
    workerTaskTitle: vi.fn(() => null),
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
  it.each(['grok', 'antigravity'] as const)(
    'codes %s native naming failures without exposing provider text',
    async (provider) => {
      const state = rig()
      const record = agentSessionRecordFixture()
      record.provider = provider
      for (const outcome of ['throw', 'empty'] as const) {
        if (outcome === 'throw') {
          mocks.native.mockRejectedValueOnce(new Error('private provider diagnostic'))
        } else {
          mocks.native.mockResolvedValueOnce('')
        }
        expect(await state.deps.generate(record, 'Repair login')).toEqual({
          errorCode: `${provider}Failed`,
          error: `${provider === 'grok' ? 'Grok' : 'Antigravity'} could not name this chat. Try generating the name again.`
        })
      }
    }
  )

  it.each([10, 100])(
    'scopes naming prompts with linear visits over %i retained items',
    async (count) => {
      let visits = 0
      const message: AgentJournalRenderItem = {
        itemId: 'fresh',
        sequence: count + 2,
        revision: 1,
        observedAt: 200,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'New task' }] }
      }
      const items: AgentJournalRenderItem[] = Array.from({ length: count }, (_, index) => ({
        ...message,
        itemId: `old-${index}`,
        get sequence() {
          visits++
          return index + 1
        },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Old task' }] }
      }))
      items.push(
        {
          ...message,
          itemId: 'clear',
          sequence: count + 1,
          body: {
            kind: 'status',
            text: 'Context cleared',
            contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 200 }
          }
        },
        message
      )
      let submissionVisits = 0
      const submission: AgentJournalSubmission = {
        ...journalSubmission('fresh', 'accepted', 'fresh'),
        acceptedSequence: count + 2,
        submittedAt: 200
      }
      const oldSubmissions: AgentJournalSubmission[] = Array.from(
        { length: count },
        (_, index) => ({
          ...submission,
          clientMessageId: `old-${index}`,
          providerItemId: `old-${index}`,
          get acceptedSequence() {
            submissionVisits++
            return index + 1
          }
        })
      )
      mocks.journalSnapshot.mockResolvedValue({
        sessionId: 'chat',
        cursor: { epoch: 'epoch', sequence: count + 2 },
        items,
        submissions: [...oldSubmissions, submission]
      })
      const { deps } = rig()
      expect(await deps.readFirstPrompt('chat', 100)).toBe('New task')
      expect(visits).toBe(2 * count)
      expect(submissionVisits).toBe(count)
      visits = 0
      expect(await deps.readJournalFirstPrompt('chat')).toBe('New task')
      expect(visits).toBe(2 * count)
    }
  )

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
      expect.objectContaining({ agentId: 'claude' }),
      expect.objectContaining({ kind: 'local', cwd: '/workspace/folder' }),
      undefined
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
      expect.anything(),
      undefined
    )
  })

  it.each(
    STRUCTURED_AGENT_RUNTIME_CATALOG.map(({ metadata }) => metadata.definition.agent).filter(
      (agent) => agent !== 'pi' && agent !== 'omp'
    )
  )('names a %s chat with its own agent regardless of global selection', async (provider) => {
    const state = rig()
    state.settings.sourceControlAi = {
      ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
      agentId: 'codex'
    }
    const record = agentSessionRecordFixture()
    record.provider = provider
    record.accountHome =
      provider === 'opencode' || provider === 'opencode2'
        ? { kind: 'opencode', locator: { kind: 'unmanaged' } }
        : {
            variable:
              provider === 'codex'
                ? 'CODEX_HOME'
                : provider === 'claude'
                  ? 'CLAUDE_CONFIG_DIR'
                  : provider === 'grok'
                    ? 'GROK_HOME'
                    : provider === 'antigravity'
                      ? 'GEMINI_HOME'
                      : 'PI_CODING_AGENT_DIR',
            path: '/pinned-account'
          }
    const shouldExecute = () => true
    await state.deps.generate(record, 'Repair login', shouldExecute)
    if (provider === 'grok' || provider === 'antigravity') {
      expect(mocks.native).toHaveBeenCalledWith(
        expect.objectContaining({ accountHome: record.accountHome, shouldExecute })
      )
      expect(mocks.generate).not.toHaveBeenCalled()
    } else {
      expect(mocks.generate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ agentId: provider }),
        expect.objectContaining({
          env: expect.objectContaining(
            'variable' in record.accountHome
              ? { [record.accountHome.variable]: record.accountHome.path }
              : {}
          )
        }),
        shouldExecute
      )
    }
    expect(state.settings.sourceControlAi?.actions?.conversationName?.agentId).toBeUndefined()
  })

  it('uses the current routed Claude account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-naming-account-test-'))
    roots.push(root)
    const home = join(root, 'claude-profiles', 'selected', 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(root, 'claude-profiles', 'selected', 'profile.json'), '{}')
    installClaudeProfileRouter(
      new ClaudeProfileRouter({
        getSettings: () => ({
          claudeManagedAccounts: [],
          activeClaudeManagedAccountId: 'selected',
          agentStatusHooksEnabled: false,
          disabledTuiAgents: []
        }),
        dataRoot: root,
        userHome: join(root, 'personal'),
        env: {}
      })
    )
    const state = rig()
    const record = agentSessionRecordFixture()
    await state.deps.generate(record, 'Repair login')
    expect(mocks.generate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: home }) }),
      undefined
    )
  })

  it.each([undefined, '/user-configured/claude'])(
    'distinguishes the explicit Claude directory %s from inherited environment under System default',
    async (configuredDir) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-naming-system-account-test-'))
      roots.push(root)
      const router = new ClaudeProfileRouter({
        getSettings: () => ({
          claudeManagedAccounts: [],
          activeClaudeManagedAccountId: null,
          agentStatusHooksEnabled: false,
          disabledTuiAgents: []
        }),
        dataRoot: root,
        userHome: join(root, 'personal'),
        env: {}
      })
      installClaudeProfileRouter(router)
      const state = rig()
      state.settings.agentDefaultEnv = {
        claude: configuredDir ? { CLAUDE_CONFIG_DIR: configuredDir } : {}
      }
      state.runtime.resolveNamingEnvironment.mockResolvedValue({
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: configuredDir ?? '/inherited/claude'
      })
      await state.deps.generate(agentSessionRecordFixture(), 'Repair login')
      expect(mocks.generate).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CONFIG_DIR: configuredDir ?? router.systemDefaultHome()
          })
        }),
        undefined
      )
    }
  )

  it.each([false, true])(
    'preserves args-only CLI recipes (explicit null: %s)',
    async (explicitNull) => {
      const state = rig()
      state.settings.defaultTuiAgent = 'claude'
      state.settings.sourceControlAi = {
        ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
        agentId: 'codex',
        actions: {
          conversationName: {
            ...(explicitNull ? { agentId: null } : {}),
            agentArgs: '--model custom',
            commandInputTemplate: 'Title: {firstPrompt}'
          }
        }
      }
      const record = agentSessionRecordFixture()
      record.provider = 'antigravity'
      await state.deps.generate(record, 'Repair login')
      expect(mocks.generate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          agentId: explicitNull ? 'claude' : 'codex',
          agentArgs: '--model custom'
        }),
        expect.anything(),
        undefined
      )
      expect(mocks.native).not.toHaveBeenCalled()
    }
  )

  it('resolves plain folder workspaces without requiring a git repository', async () => {
    const state = rig()
    const record = agentSessionRecordFixture()
    record.location.workspaceKind = 'folder'
    expect(await state.deps.generate(record, 'Repair login')).toEqual({ name: 'Login repair' })
    expect(state.runtime.resolveWorkspace).toHaveBeenCalledWith(record.location.workspaceId)
    expect(state.runtime.resolveNamingEnvironment).toHaveBeenCalledWith('claude')
  })

  it.each(['ssh', 'wsl'])(
    'skips unsupported %s even with invalid native settings',
    async (kind) => {
      const state = rig()
      state.settings.sourceControlAi = {
        ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
        actions: { conversationName: { agentId: 'custom' } },
        customAgentCommand: ''
      }
      const record = agentSessionRecordFixture()
      if (kind === 'wsl') {
        record.location.wslDistro = 'Ubuntu'
      }
      const remote = structuredChatNamingDeps(
        () => ({ getSettings: () => state.settings }),
        {
          ...state.runtime,
          resolveWorkspace: async () => ({
            path: '/remote/workspace',
            executionHostId: kind === 'ssh' ? toSshExecutionHostId('target') : 'local'
          })
        },
        state.logger
      )
      expect(await remote.generate(record, 'Repair login')).toBeNull()
      expect(state.logger.warn).not.toHaveBeenCalled()
      expect(mocks.target).not.toHaveBeenCalled()
      expect(mocks.generate).not.toHaveBeenCalled()
    }
  )

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

  it('reports invalid agent configuration without launching anything', async () => {
    const state = rig()
    state.settings.sourceControlAi = {
      ...normalizeSourceControlAiSettings(state.settings.sourceControlAi),
      actions: { conversationName: { agentId: 'custom' } },
      customAgentCommand: ''
    }
    expect(await state.deps.generate(agentSessionRecordFixture(), 'Repair login')).toEqual({
      error: expect.any(String)
    })
    expect(state.logger.warn).toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
