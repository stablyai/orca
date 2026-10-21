// What the picker shows for a chat's speed is what its next turn runs, on any host's answer.

import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import { dropUnlistedCodexServiceTier } from './codex-structured-service-tier'

const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
// M1 offers Fast and Flex; M2 offers only Ultrafast.
const MODELS: AgentSessionModelOption[] = [
  { id: 'm1', label: 'M1', isDefault: true, efforts: [], serviceTiers: tiers('priority', 'flex') },
  { id: 'm2', label: 'M2', isDefault: false, efforts: [], serviceTiers: tiers('ultrafast') }
]

/** The tier the first turn after a start carries, and the session's tier after a live read. */
async function hostRuns(saved: Record<string, string>) {
  const store = new AgentModelCatalogStore()
  store.recordSuccess('codex-account', 'codex', { models: MODELS, origin: 'probe' }, 'discovery')
  const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
    turn: { id: 'turn-1' }
  }))
  const session: CodexSession = {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(Object.entries(saved)),
    reportedOptions: {},
    catalogAccess: { store, fingerprint: 'codex-account', accountHomePath: '/account' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
  await startCodexTurn(session, {
    clientMessageId: 'message-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  })
  const firstTurn = request.mock.calls.find(([method]) => method === 'turn/start')?.[1]
  dropUnlistedCodexServiceTier(session, saved.model, MODELS)
  return { firstTurn: firstTurn?.serviceTier, afterLiveRead: session.options.get('serviceTier') }
}

/** A host's answer naming the saved values; an older host marks no defaults. */
function answered(saved: Record<string, string>, marksDefaults: boolean) {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    CODEX_SESSION_OPTION_CATALOG,
    { models: MODELS, current: { ...saved, ...(marksDefaults ? { defaulted: [] } : {}) } }
  )
}

function shownTier(state: StructuredAgentSessionOptionState): string | undefined {
  const kind = structuredAgentSessionOptionSnapshot(state).find(
    (entry) => entry.id === 'serviceTier'
  )?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

describe("a Codex chat's speed, shown and sent", () => {
  it('shows what the host runs, an older host as it sends it, and keeps the saved tier', async () => {
    // [saved, shown from this host, shown from an older host, what this host's turns run]
    for (const [saved, shown, olderShown, runs] of [
      [{ model: 'm2', serviceTier: 'priority' }, 'default', 'default', 'default'],
      [{ model: 'm2', serviceTier: 'flex' }, 'default', 'flex', 'default'],
      [{ model: 'm1', serviceTier: 'priority' }, 'priority', 'priority', 'priority']
    ] as const) {
      expect(shownTier(answered(saved, true))).toBe(shown)
      // An older host sends its Flex unchanged, and Codex passes Flex.
      expect(shownTier(answered(saved, false))).toBe(olderShown)
      await expect(hostRuns(saved)).resolves.toEqual({ firstTurn: runs, afterLiveRead: runs })
    }
    // Back on a model that offers it, the saved tier is the chat's again.
    const back = commitStructuredAgentSessionOption(
      answered({ model: 'm2', serviceTier: 'flex' }, true),
      'model',
      'm1'
    )
    expect(shownTier(back)).toBe('flex')
    await expect(hostRuns({ model: 'm1', serviceTier: 'flex' })).resolves.toMatchObject({
      firstTurn: 'flex'
    })
  })
})
