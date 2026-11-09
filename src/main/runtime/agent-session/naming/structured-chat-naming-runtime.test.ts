import { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import {
  acquired,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  PROVIDER_SESSION_ID
} from '../../../claude/structured/claude-structured-session-test-support'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeControlSurface } from '../../../claude/claude-agent-sdk-control-requests'
import {
  createStructuredChatNamingHandler,
  type StructuredChatNamingDeps
} from '../../../native-chat/structured-chat-naming'
import { compareAndSetAgentSessionRecordName } from '../records/agent-session-record-conversation-name'
import { rm } from 'node:fs/promises'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type { AgentJournalSnapshot } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type * as TextGeneration from '../../../text-generation/commit-message-text-generation'

const mocks = vi.hoisted(() => ({
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  })),
  native: vi.fn(async () => 'Native title'),
  titleOwner: vi.fn(),
  record: vi.fn(),
  generate: vi.fn<typeof TextGeneration.generateConversationNameFromContext>(async () => ({
    success: true as const,
    name: 'Login repair'
  })),
  target: vi.fn(async (cwd: string) => ({ kind: 'local' as const, cwd })),
  publishConversationName: vi.fn<(sessionId: string) => void>(),
  journalCurrentRead: vi.fn<(sessionId: string) => Promise<AgentJournalSnapshot>>()
}))

vi.mock('../../../text-generation/commit-message-text-generation', async (importOriginal) => {
  const actual = await importOriginal<typeof TextGeneration>()
  return { ...actual, generateConversationNameFromContext: mocks.generate }
})
vi.mock('../../../agent-hooks/first-work/first-work-generation-target', () => ({
  resolveGenerationTarget: mocks.target
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    deps: {
      store: { getRecord: mocks.record },
      adapter: { generateText: mocks.native, captureConversationTitleOwner: mocks.titleOwner }
    },
    publishConversationName: mocks.publishConversationName,
    journalCurrentRead: mocks.journalCurrentRead
  })
}))

vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: mocks.account
  })
}))
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  installClaudeProfileRouter(undefined)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.titleOwner.mockReset()
  mocks.record.mockReset()
})

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
  it('uses the CLI title only for automatic default naming and honors changed settings', async () => {
    const state = rig()
    const record = agentSessionRecordFixture()
    const pending = Promise.withResolvers<string>()
    const generate = vi.fn(() => pending.promise)
    mocks.titleOwner.mockReturnValue({ isCurrent: () => true, generate })
    const result = state.deps.generate(
      record,
      'Repair login',
      () => true,
      state.deps.captureAutomaticTitle!(record)
    )
    await vi.waitFor(() => expect(generate).toHaveBeenCalled())
    pending.resolve('Broken chat title')
    expect(await result).toMatchObject({ name: 'Broken chat title' })
    expect(mocks.generate).not.toHaveBeenCalled()
    await state.deps.generate(record, 'Repair login')
    expect(mocks.generate).toHaveBeenCalledOnce()

    generate.mockImplementationOnce(async () => {
      state.settings.sourceControlAi!.actions!.conversationName = {
        commandInputTemplate: 'Custom {basePrompt}'
      }
      return 'Wrong settings title'
    })
    expect(
      await state.deps.generate(
        record,
        'Repair login',
        () => true,
        state.deps.captureAutomaticTitle!(record)
      )
    ).toEqual({ name: 'Login repair' })
  })

  it.each(['action', 'shared', 'legacy', 'seeded-default', 'effort', 'template'] as const)(
    'preserves authored %s naming choices without consulting the CLI',
    async (choice) => {
      const state = rig()
      const source = state.settings.sourceControlAi!
      if (choice === 'action') {
        source.modelOverridesByOperation = {
          conversationName: { selectedModelByAgent: { claude: 'opus' } }
        }
      }
      if (choice === 'shared') {
        source.selectedModelByAgent = { claude: 'opus' }
      }
      if (choice === 'legacy') {
        state.settings.commitMessageAi!.selectedModelByAgent = { claude: 'opus' }
      }
      if (choice === 'seeded-default') {
        state.settings.commitMessageAi!.selectedModelByAgent = { claude: 'sonnet' }
        state.settings.commitMessageAi!.selectedThinkingByModel = { sonnet: 'high' }
      }
      if (choice === 'effort') {
        source.selectedThinkingByModel = { sonnet: 'high' }
      }
      if (choice === 'template') {
        source.actions!.conversationName = { commandInputTemplate: 'Custom {basePrompt}' }
      }
      const record = agentSessionRecordFixture()
      expect(
        await state.deps.generate(
          record,
          'Repair login',
          () => true,
          state.deps.captureAutomaticTitle!(record)
        )
      ).toEqual({ name: 'Login repair' })
      expect(mocks.titleOwner).not.toHaveBeenCalled()
    }
  )
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
})

function automaticNaming(state: ReturnType<typeof rig>, before?: 'prompt' | 'seed') {
  let record = agentSessionRecordFixture()
  record.sessionId = 'session-1'
  record.lease.sessionId = 'session-1'
  record.providerHandleChain[0]!.handle.nativeId = PROVIDER_SESSION_ID
  const blocked = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const pause = async (stage: 'prompt' | 'seed') => {
    if (before === stage) {
      entered.resolve()
      await blocked.promise
    }
  }
  const store = {
    getRecord: () => record,
    compareAndSetConversationName: async (_id, name, expected, context, applicable) =>
      compareAndSetAgentSessionRecordName(
        async (apply) => {
          if (expected === null) {
            await pause('seed')
          }
          record = apply(record)
          return record
        },
        name,
        expected,
        context,
        applicable
      ),
    setUserConversationName: vi.fn()
  } satisfies NonNullable<ReturnType<StructuredChatNamingDeps['getStore']>>
  mocks.record.mockImplementation(() => record)
  const handler = createStructuredChatNamingHandler({
    ...state.deps,
    getStore: () => store,
    readFirstPrompt: async () => {
      await pause('prompt')
      return 'Repair login'
    },
    wait: async () => {}
  })
  return {
    handler,
    entered: entered.promise,
    release: () => blocked.resolve(),
    record: () => record,
    replace: () => {
      record = { ...record, lease: { ...record.lease, runtimeFence: 8 } }
    },
    start: () =>
      handler(
        {
          sessionId: record.sessionId,
          workspaceId: 'workspace-1',
          agent: 'claude',
          status: 'working',
          latestPrompt: 'Repair login',
          updatedAt: 1
        },
        { replay: false, firstInputSubmissionKey: 'input-1' }
      )
  }
}

it.each(['prompt', 'seed', 'workspace', 'support'] as const)(
  'retains the accepted input owner while %s preparation is pending',
  async (stage) => {
    const state = rig()
    const blocked = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    if (stage === 'workspace') {
      state.runtime.resolveWorkspace.mockImplementationOnce(async () => {
        entered.resolve()
        await blocked.promise
        return { path: '/workspace/folder', executionHostId: 'local' }
      })
    }
    const naming = automaticNaming(
      state,
      stage === 'prompt' || stage === 'seed' ? stage : undefined
    )
    const control = vi.fn(async () => 'Successor title')
    mocks.titleOwner.mockImplementation(() => {
      const fence = naming.record().lease.runtimeFence
      return {
        isCurrent: (current: AgentSessionRecord) => current.lease.runtimeFence === fence,
        generate: async (_prompt: string, shouldExecute: () => boolean) => {
          if (stage === 'support') {
            entered.resolve()
            await blocked.promise
          }
          return shouldExecute() ? control() : null
        }
      }
    })
    naming.start()
    await (stage === 'workspace' || stage === 'support' ? entered.promise : naming.entered)
    naming.replace()
    naming.release()
    blocked.resolve()
    await vi.waitFor(() => expect(naming.handler.activeSessionIds()).toEqual([]))
    expect(control).not.toHaveBeenCalled()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(naming.record().conversationName).toBe('Login repair')
  }
)

it.each([false, true])(
  'bounds timeout fallback to its owner (retired=%s), retries independently, and ignores late CLI results',
  async (retired) => {
    const state = rig()
    const pending = Promise.withResolvers<string>()
    const generateSessionTitle = vi.fn(() => pending.promise)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this flow calls only the feature-detected title method.
    const controls = createClaudeControlSurface({ generateSessionTitle } as unknown as Query)
    let owned = true
    mocks.titleOwner.mockReturnValue({
      isCurrent: () => owned,
      generate: controls.generateSessionTitle
    })
    mocks.generate
      .mockResolvedValueOnce({ success: false, error: 'Retry naming' })
      .mockImplementationOnce(async () => {
        if (retired) {
          owned = false
        }
        return { success: true, name: 'Recovered name' }
      })
    const naming = automaticNaming(state)
    vi.useFakeTimers()
    naming.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(naming.record().conversationName).toBe(retired ? 'Repair login' : 'Recovered name')
    pending.resolve('Late CLI name')
    await vi.advanceTimersByTimeAsync(0)
    expect(naming.record().conversationName).toBe(retired ? 'Repair login' : 'Recovered name')
    expect(generateSessionTitle).toHaveBeenCalledOnce()
    expect(mocks.generate).toHaveBeenCalledTimes(2)
    expect(naming.handler.activeSessionIds()).toEqual([])
  }
)

it.each([
  { support: 'unsupported' as const, transition: 'close', response: 'unused' },
  { support: 'unknown' as const, transition: 'replacement', response: 'unused' },
  { support: 'supported' as const, transition: 'replacement', response: 'error' },
  { support: 'supported' as const, transition: 'close', response: 'null' }
])(
  'finishes independent naming after $transition with support=$support and response=$response',
  async ({ support, transition, response }) => {
    const cli = fakeClaude()
    const adapter = await acquired(cli, { cliFlag: async () => support })
    const state = rig()
    const naming = automaticNaming(state)
    const entered = Promise.withResolvers<void>()
    const independent =
      Promise.withResolvers<
        Awaited<ReturnType<typeof TextGeneration.generateConversationNameFromContext>>
      >()
    const control = vi.fn(async () => {
      if (response === 'error') {
        throw new Error('Optional control rejected')
      }
      return response === 'null' ? null : 'Wrong live title'
    })
    cli.connections[0]!.generateSessionTitle = control
    mocks.titleOwner.mockImplementation((record) => adapter.captureConversationTitleOwner(record))
    mocks.generate.mockImplementationOnce(async () => {
      entered.resolve()
      return independent.promise
    })
    try {
      naming.start()
      await entered.promise
      await adapter.closeSession('session-1')
      if (transition === 'replacement') {
        naming.replace()
        await adapter.acquire({
          identity: identityFor(),
          fence: 8,
          spawnToken: 'replacement',
          events: recordingJournalSink()
        })
        cli.connections[1]!.generateSessionTitle = control
      }
      independent.resolve({ success: true, name: 'Independent completion' })
      await vi.waitFor(() => expect(naming.handler.activeSessionIds()).toEqual([]))
      expect(naming.record().conversationName).toBe('Independent completion')
      expect(control).toHaveBeenCalledTimes(response === 'unused' ? 0 : 1)
    } finally {
      await adapter.closeAll()
      cli.dispose()
    }
  }
)

it('discards a retired CLI result and publishes only independent fallback text', async () => {
  const cli = fakeClaude()
  const adapter = await acquired(cli)
  const state = rig()
  const naming = automaticNaming(state)
  const pending = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  cli.connections[0]!.generateSessionTitle = async () => {
    started.resolve()
    return pending.promise
  }
  mocks.titleOwner.mockImplementation((record) => adapter.captureConversationTitleOwner(record))
  try {
    naming.start()
    await started.promise
    await adapter.closeSession('session-1')
    pending.resolve('Stale CLI title')
    await vi.waitFor(() => expect(naming.handler.activeSessionIds()).toEqual([]))
    expect(naming.record().conversationName).toBe('Login repair')
  } finally {
    await adapter.closeAll()
    cli.dispose()
  }
})

it.each(['capture', 'pending result'] as const)(
  'keeps the seed and existing naming failure when account lookup fails at %s',
  async (stage) => {
    const cli = fakeClaude()
    const adapter = await acquired(cli)
    const state = rig()
    const naming = automaticNaming(state)
    const router = new ClaudeProfileRouter({
      getSettings: () => ({
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      }),
      dataRoot: '/isolated',
      userHome: '/users/test',
      env: {}
    })
    const preparation = vi.spyOn(router, 'preparation')
    installClaudeProfileRouter(router)
    const unavailable = () => {
      throw new Error('Selected account folder missing')
    }
    const pending = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    cli.connections[0]!.generateSessionTitle = async () => {
      started.resolve()
      return pending.promise
    }
    mocks.titleOwner.mockImplementation((record) => adapter.captureConversationTitleOwner(record))
    state.runtime.resolveNamingEnvironment.mockImplementation(async () => unavailable())
    try {
      if (stage === 'capture') {
        preparation.mockImplementation(unavailable)
      }
      naming.start()
      if (stage === 'pending result') {
        await started.promise
        preparation.mockImplementation(unavailable)
        pending.resolve('Unusable account title')
      }
      await vi.waitFor(() => expect(naming.handler.activeSessionIds()).toEqual([]))
      expect(naming.record().conversationName).toBe('Repair login')
      expect(naming.handler.failure('session-1')?.messageCode).toBe('agentNotRun')
    } finally {
      await adapter.closeAll()
      cli.dispose()
    }
  }
)
