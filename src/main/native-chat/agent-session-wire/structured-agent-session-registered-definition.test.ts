// The registry is the only source of an agent's definition: routing, declared capabilities and the
// option rules a chat at rest reads all follow what composition registered, and a definition this
// build ships but did not register decides nothing.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

const RECORD: AgentSessionRecord = {
  ...agentSessionRecordFixture(),
  options: { model: 'pilot-model' }
}

/** Claude, registered with rules unlike the ones Claude's own module declares. */
const NON_DEFAULT: StructuredAgentDefinition = {
  ...CLAUDE_STRUCTURED_AGENT,
  capabilities: { ...CLAUDE_STRUCTURED_AGENT.capabilities, threadGoal: true },
  restingOptions: {
    acceptsKey: (key) => key === 'pilotOption',
    fallbackModels: () => [
      { id: 'pilot-model', label: 'Pilot', isDefault: true, defaultEffort: 'low', efforts: [] }
    ],
    effortDefaultsToModel: true
  }
}

function fakeAdapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: claudeProviderHandle('provider-session-1', null),
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: 1
      }
    })),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn(),
    compact: vi.fn(),
    changeThreadGoal: vi.fn()
  }
}

function pick(agents: StructuredAgentRegistry, record: AgentSessionRecord | null, key: string) {
  const persistOptions = vi.fn(async () => {})
  const result = recordStructuredAgentSessionOptionIntent(
    { store: { getRecord: () => record }, agents },
    { sessionId: RECORD.sessionId, persistOptions, publish: vi.fn() },
    { key, value: 'enabled' }
  )
  return { result, persistOptions }
}

function readAtRest(agents: StructuredAgentRegistry) {
  const resting = {
    child: null,
    params: { provider: RECORD.provider },
    journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: new StructuredAgentSessionAdapterRouter(agents, async () => {}),
      agents,
      store: { getRecord: () => RECORD }
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, RECORD.sessionId)
}

describe('a registered definition', () => {
  it('routes, declares capabilities and rules options at rest for its agent', async () => {
    const adapter = fakeAdapter()
    const agents = new StructuredAgentRegistry([{ definition: NON_DEFAULT, adapter }])
    const router = new StructuredAgentSessionAdapterRouter(agents, async () => {})

    await router.acquire({
      identity: {
        sessionId: 'session-routed',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'spawn-1'
    })
    expect(adapter.acquire).toHaveBeenCalledOnce()
    expect(agents.capabilities(RECORD.provider)).toBe(NON_DEFAULT.capabilities)

    const accepted = pick(agents, RECORD, 'pilotOption')
    await expect(accepted.result).resolves.toMatchObject({ ok: true })
    expect(accepted.persistOptions).toHaveBeenCalledWith({
      model: 'pilot-model',
      pilotOption: 'enabled'
    })
    // Claude's own module accepts `model`; the registration says otherwise and wins.
    const refused = pick(agents, RECORD, 'model')
    await expect(refused.result).resolves.toMatchObject({ ok: false })

    const options = await readAtRest(agents)
    expect(options.models.map((model) => model.id)).toEqual(['pilot-model'])
    // No pick for effort: the registered rules read the model's default.
    expect(options.current).toEqual({ model: 'pilot-model', effort: 'low' })
    expect(options.threadGoal).toEqual({ current: null })
  })

  it('leaves an agent this runtime did not register with no rules, whatever the build ships', async () => {
    const agents = new StructuredAgentRegistry([
      {
        definition: CODEX_STRUCTURED_AGENT,
        adapter: { ...fakeAdapter(), rewind: vi.fn(), recoverRewind: vi.fn() }
      }
    ])

    expect(agents.definition(RECORD.provider)).toBeNull()
    expect(agents.capabilities(RECORD.provider)).toBeNull()
    const refused = pick(agents, RECORD, 'model')
    await expect(refused.result).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'optionRejected' } }
    })
    expect(refused.persistOptions).not.toHaveBeenCalled()
    const options = await readAtRest(agents)
    expect(options.models).toEqual([])
    expect(options.current).toEqual({ model: 'pilot-model' })
    expect(options.conversationCommands).toEqual(['clear'])
  })

  it('refuses a pick for a session with no record, as before', async () => {
    const agents = new StructuredAgentRegistry([
      { definition: CLAUDE_STRUCTURED_AGENT, adapter: fakeAdapter() }
    ])
    const missing = pick(agents, null, 'model')
    await expect(missing.result).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(missing.persistOptions).not.toHaveBeenCalled()
  })
})
