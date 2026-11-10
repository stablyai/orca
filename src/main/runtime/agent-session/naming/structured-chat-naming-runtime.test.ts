import { rm } from 'node:fs/promises'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type * as TextGeneration from '../../../text-generation/commit-message-text-generation'
import * as shellEnvironment from '../environment/structured-agent-shell-environment'
import { resolveHostStructuredAgentLaunchEnvironment } from '../launch/structured-agent-launch-support'

const mocks = vi.hoisted(() => ({
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  })),
  native: vi.fn(async () => 'Native title'),
  generate: vi.fn(async () => ({ success: true as const, name: 'Login repair' })),
  target: vi.fn(async (cwd: string) => ({ kind: 'local' as const, cwd })),
  publishConversationName: vi.fn<(sessionId: string) => void>(),
  namingPrompt: vi.fn(async () => '')
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
    deps: { adapter: { generateText: mocks.native } },
    publishConversationName: mocks.publishConversationName,
    namingPrompt: mocks.namingPrompt
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
  vi.restoreAllMocks()
  vi.useRealTimers()
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
  it('resolves Claude naming inheritance before the deliberate agent launch environment', async () => {
    const inherited = {
      CLAUDE_CODE_MESSAGING_SOCKET: 'parent-socket',
      CLAUDE_CODE_ENTRYPOINT: 'parent-client',
      CLAUDE_EFFORT: 'parent-effort',
      CLAUDE_CODE_HTTP_PROXY: 'http://user-proxy'
    }
    vi.spyOn(shellEnvironment, 'resolveHostAgentBaseEnvironment').mockResolvedValue(inherited)
    const settings = getDefaultSettings('/isolated')
    settings.agentDefaultEnv = { claude: { CLAUDE_EFFORT: 'chosen-effort' } }
    const env = await resolveHostStructuredAgentLaunchEnvironment('claude', settings)
    expect(env).toMatchObject({
      CLAUDE_EFFORT: 'chosen-effort',
      CLAUDE_CODE_HTTP_PROXY: 'http://user-proxy'
    })
    expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(
      (await resolveHostStructuredAgentLaunchEnvironment('codex', settings)).CLAUDE_EFFORT
    ).toBe('parent-effort')
    expect(inherited.CLAUDE_CODE_MESSAGING_SOCKET).toBe('parent-socket')
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
      expect(await state.deps.generate(record, 'Repair login', () => true)).toEqual({
        name: 'Login repair'
      })
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
