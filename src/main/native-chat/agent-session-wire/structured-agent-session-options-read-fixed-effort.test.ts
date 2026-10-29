import { describe, expect, it } from 'vitest'
import { claudeFallbackModelOptions } from '../../claude/claude-structured-session-options'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  hostTestOptionsReadStore,
  hostTestRestingOptionsJournal,
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

function readLive(installed: AgentSessionModelOption[], live: StructuredAgentSessionLiveOptions) {
  const record = {
    ...hostTestRestingOptionsRecord(),
    provider: 'claude',
    options: { model: 'opus', effort: 'high' }
  }
  const session = {
    child: { fence: 1 },
    params: { provider: record.provider },
    journal: hostTestRestingOptionsJournal([], false)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
  const context = {
    deps: {
      adapter: { readOptions: async () => live },
      agents: claudeAndCodexAgents(),
      store: hostTestOptionsReadStore(() => record),
      modelCatalog: { read: async () => ({ origin: 'probe', models: installed, fetchedAt: 1 }) }
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => session,
    conversation: async () => session
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
}

describe('a live Claude chat whose CLI cannot change effort mid-chat', () => {
  // Claude Code before 2.1.50 never answers the effort/Fast control its installed rows still list.
  it('offers no effort or Fast from the installed rows', async () => {
    const result = await readLive(
      [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: false,
          efforts: [{ value: 'high', label: 'High' }],
          effortsKnown: false,
          supportsFastMode: true
        }
      ],
      {
        models: claudeFallbackModelOptions(),
        fastModeSupport: { supported: false, reason: 'cli-update-required' },
        effortFixed: true,
        current: { model: 'opus' }
      }
    )

    expect(result.models).toEqual([
      { id: 'opus', label: 'Opus', isDefault: false, efforts: [], supportsFastMode: true }
    ])
    expect(result.fastModeSupport).toEqual({ supported: false, reason: 'cli-update-required' })
    expect(result).not.toHaveProperty('effortFixed')
  })
})
