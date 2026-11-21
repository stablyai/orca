import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { SourceControlActionRecipe } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'

const { generateNameMock, chatTargetMock, cliTargetMock, nativeGenerateText } = vi.hoisted(() => ({
  generateNameMock: vi.fn(),
  chatTargetMock: vi.fn(),
  cliTargetMock: vi.fn(),
  nativeGenerateText: vi.fn()
}))

vi.mock('../../../text-generation/commit-message-text-generation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateConversationNameFromContext: generateNameMock
}))
vi.mock('./structured-chat-naming-agent-launch', () => ({ chatNamingAgentTarget: chatTargetMock }))
vi.mock('../../../agent-hooks/first-work/first-work-generation-target', () => ({
  resolveGenerationTarget: cliTargetMock
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: { generateText: nativeGenerateText } } })
}))

import { structuredChatNamingDeps } from './structured-chat-naming-runtime'

type Options = {
  provider: string
  recipe?: SourceControlActionRecipe
  defaultTuiAgent?: TuiAgent | 'blank'
  disabledTuiAgents?: TuiAgent[]
}

function generate({ provider, recipe, defaultTuiAgent, disabledTuiAgents }: Options) {
  const base = getDefaultSettings('/tmp/orca-chat-naming-test')
  const settings = {
    ...base,
    ...(defaultTuiAgent ? { defaultTuiAgent } : {}),
    ...(disabledTuiAgents ? { disabledTuiAgents } : {}),
    sourceControlAi: {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        conversationName: { commandInputTemplate: '{basePrompt}', ...recipe }
      }
    }
  }
  const deps = structuredChatNamingDeps(
    () => ({ getSettings: () => settings }),
    {
      resolveWorkspace: async () => ({ path: '/repo', executionHostId: LOCAL_EXECUTION_HOST_ID }),
      resolveNamingEnvironment: async () => ({}),
      getAgentEnvResolvers: () => undefined,
      workerTaskTitle: () => null,
      retitleOpenTab: () => {}
    },
    { warn: vi.fn(), error: vi.fn() }
  )
  const record: AgentSessionRecord = { ...agentSessionRecordFixture(), provider }
  return deps.generate(record, 'Fix the login bug')
}

const launches = () =>
  generateNameMock.mock.calls.length +
  chatTargetMock.mock.calls.length +
  cliTargetMock.mock.calls.length

/** Explicit Arguments with no agent chosen: the CLI recipe inherits the default launch agent. */
const CLI_ARGS_RECIPE: SourceControlActionRecipe = {
  commandInputTemplate: '{basePrompt}',
  agentArgs: '--fast'
}

beforeEach(() => {
  for (const mock of [generateNameMock, chatTargetMock, cliTargetMock, nativeGenerateText]) {
    mock.mockReset()
  }
  generateNameMock.mockResolvedValue({ success: true, name: 'Fix login' })
  chatTargetMock.mockResolvedValue({ kind: 'local', cwd: '/repo' })
  cliTargetMock.mockResolvedValue({ kind: 'local', cwd: '/repo' })
  nativeGenerateText.mockResolvedValue('Fix login')
})

describe('chat naming agent selection', () => {
  it('names a Claude chat with its own agent', async () => {
    await expect(generate({ provider: 'claude' })).resolves.toEqual({ name: 'Fix login' })
    expect(generateNameMock.mock.calls[0]?.[1]).toMatchObject({ agentId: 'claude' })
  })

  it('keeps native Grok naming', async () => {
    await expect(generate({ provider: 'grok' })).resolves.toEqual({ name: 'Fix login' })
    expect(nativeGenerateText).toHaveBeenCalledOnce()
    expect(launches()).toBe(0)
  })

  it('skips a Claude chat whose CLI Arguments inherit an incapable default, Claude enabled', async () => {
    const result = await generate({
      provider: 'claude',
      recipe: CLI_ARGS_RECIPE,
      defaultTuiAgent: 'gemini',
      disabledTuiAgents: []
    })
    expect(result).toMatchObject({ skipAutomatic: true, error: expect.any(String) })
    expect(launches()).toBe(0)
  })

  it('keeps the Claude fallback for CLI Arguments with a blank default', async () => {
    await expect(
      generate({ provider: 'claude', recipe: CLI_ARGS_RECIPE, defaultTuiAgent: 'blank' })
    ).resolves.toEqual({ name: 'Fix login' })
    expect(cliTargetMock).toHaveBeenCalledOnce()
    expect(generateNameMock.mock.calls[0]?.[1]).toMatchObject({ agentId: 'claude' })
  })

  it('reports an explicitly chosen chat-name agent that cannot name, without skipping', async () => {
    const result = await generate({
      provider: 'claude',
      recipe: { commandInputTemplate: '{basePrompt}', agentId: 'gemini' }
    })
    expect(result).toEqual({ error: expect.stringContaining('does not support chat names') })
    expect(launches()).toBe(0)
  })

  // Compatibility: a stored record from a provider with no text generation; new chats can't start one.
  it('skips a stored Gemini chat under Use chat agent without launching another provider', async () => {
    const result = await generate({ provider: 'gemini' })
    expect(result).toMatchObject({ skipAutomatic: true, error: expect.any(String) })
    expect(launches()).toBe(0)
  })

  it('skips a stored provider Orca does not know instead of launching the default agent', async () => {
    const result = await generate({ provider: 'retired-agent', defaultTuiAgent: 'claude' })
    expect(result).toMatchObject({
      skipAutomatic: true,
      error: expect.stringContaining('retired-agent')
    })
    expect(launches()).toBe(0)
  })
})
