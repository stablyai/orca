import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  canSetStructuredAgentSessionOption
} from '../../shared/structured-agent-session-options'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

const RUNNING_MODEL = 'new-current-model'

function fixture(listing: 'empty' | 'error' | 'no-effort' | 'limited') {
  const claude = fakeClaude({
    initModels: [],
    settings: { applied: { model: RUNNING_MODEL, effort: 'high' }, effective: {} },
    routes: {
      list_models: () => {
        if (listing === 'error') {
          throw new Error('temporarily unavailable')
        }
        return listing === 'empty'
          ? []
          : [
              {
                value: RUNNING_MODEL,
                displayName: 'Current model',
                supportsEffort: listing === 'limited',
                supportedEffortLevels: listing === 'limited' ? ['low', 'high'] : []
              }
            ]
      }
    }
  })
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/folder',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: () => {},
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    persistHandle: async () => {}
  })
}

async function started(listing: Parameters<typeof fixture>[0]) {
  const adapter = fixture(listing)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
  await claudeStartupSettled(adapter, 'session-1')
  const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
    CLAUDE_SESSION_OPTION_CATALOG,
    result
  )
  return { adapter, result, state }
}

describe('Claude model capabilities a running child cannot list', () => {
  it.each(['empty', 'error'] as const)(
    'offers no effort levels for a running model no list names after an %s listing',
    async (listing) => {
      const { adapter, result, state } = await started(listing)
      try {
        expect(result.current.model).toBe(RUNNING_MODEL)
        // Nothing says which levels it takes, so none is offered rather than one it may reject.
        expect(result.models.find((model) => model.id === RUNNING_MODEL)).toMatchObject({
          efforts: []
        })
        expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(false)
        expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(false)
      } finally {
        await adapter.closeAll()
      }
    }
  )

  it.each(['no-effort', 'limited'] as const)(
    'keeps the live %s capability restriction authoritative',
    async (listing) => {
      const { adapter, state } = await started(listing)
      try {
        expect(canSetStructuredAgentSessionOption(state, 'effort', 'xhigh')).toBe(false)
        expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(
          listing === 'limited'
        )
        await expect(
          adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'xhigh', fence: 7 })
        ).rejects.toThrow('does not accept effort xhigh')
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
