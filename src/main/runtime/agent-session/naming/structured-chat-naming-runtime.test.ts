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
  generate: vi.fn(async () => ({ success: true as const, name: 'Login repair' })),
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
  installClaudeProfileRouter(undefined)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.titleOwner.mockReset()
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
    const retainOwnership = vi.fn()
    mocks.titleOwner.mockReturnValue({ isCurrent: () => true, generate })
    const result = state.deps.generate(record, 'Repair login', () => true, { retainOwnership })
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
      await state.deps.generate(record, 'Repair login', () => true, { retainOwnership })
    ).toEqual({ name: 'Login repair' })
  })

  it.each(['action', 'shared', 'legacy', 'effort', 'template'] as const)(
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
      if (choice === 'effort') {
        source.selectedThinkingByModel = { sonnet: 'high' }
      }
      if (choice === 'template') {
        source.actions!.conversationName = { commandInputTemplate: 'Custom {basePrompt}' }
      }
      expect(
        await state.deps.generate(agentSessionRecordFixture(), 'Repair login', () => true, {
          retainOwnership: () => {}
        })
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
