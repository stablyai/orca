import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions
} from '../../shared/native-chat-session-option-defaults'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

// A model the built-in list offers, picked after the running child named none.
const PICKED_MODEL = CLAUDE_SESSION_OPTION_CATALOG.models[0]!.id

function fixture(listing: 'empty' | 'error') {
  const claude = fakeClaude({
    initModels: [],
    settings: {},
    routes: {
      list_models: () => {
        if (listing === 'error') {
          throw new Error('temporarily unavailable')
        }
        return []
      }
    }
  })
  const adapter = new ClaudeStructuredSessionAdapter({
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
  return { adapter }
}

describe('Claude unknown current model persistence', () => {
  it.each(['empty', 'error'] as const)(
    'keeps an effort-only choice off future model flags after an %s listing',
    async (listing) => {
      const { adapter } = fixture(listing)
      try {
        await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
        await claudeStartupSettled(adapter, 'session-1')
        const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
          CLAUDE_SESSION_OPTION_CATALOG,
          result
        )
        expect(result.current.model).toBeUndefined()
        const [model] = structuredAgentSessionOptionSnapshot(state)
        expect(model).toMatchObject({ valueSource: 'unknown' })
        expect(model.kind).not.toHaveProperty('currentValue')
        const committed = await adapter.setOption({
          sessionId: 'session-1',
          key: 'effort',
          value: 'high',
          fence: 7
        })
        expect(committed).toEqual({ effort: 'high' })
        const picks = structuredAgentSessionOptionPicks(state, committed ?? {})
        const persisted = applyNativeChatSessionOptionPicks({
          persisted: null,
          agent: 'claude',
          picks
        })
        const launch = resolveStructuredLaunchSeedOptions(persisted, 'claude')
        expect(picks).toEqual([])
        expect(launch?.model).toBeUndefined()
        const selection = await adapter.setOption({
          sessionId: 'session-1',
          key: 'model',
          value: PICKED_MODEL,
          fence: 7
        })
        const selected = applyNativeChatSessionOptionPicks({
          persisted,
          agent: 'claude',
          picks: structuredAgentSessionOptionPicks(state, selection ?? {})
        })
        expect(resolveStructuredLaunchSeedOptions(selected, 'claude')?.model).toBe(PICKED_MODEL)
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
