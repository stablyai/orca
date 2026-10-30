import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
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
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import { startCodexTurn } from './codex-structured-turn-start'
import { readLiveCodexSessionOptions } from './codex-structured-session-options'

const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
const MODELS: AgentSessionModelOption[] = [
  { id: 'm1', label: 'M1', isDefault: true, efforts: [], serviceTiers: tiers('priority', 'flex') },
  { id: 'm2', label: 'M2', isDefault: false, efforts: [], serviceTiers: tiers('ultrafast') }
]

async function hostRuns(
  saved: Record<string, string>,
  ageMs = 0,
  child?: { tiers?: readonly string[]; reported?: string },
  observeProjection?: (projected: Readonly<Record<string, string>> | undefined) => void
) {
  let now = 1
  const store = new AgentModelCatalogStore({ now: () => now })
  store.recordSuccess(
    'codex-account',
    'codex',
    { models: MODELS, complete: true, origin: 'probe' },
    'discovery'
  )
  now += ageMs
  let offline = false
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method !== 'model/list') {
      return { turn: { id: 'turn-1' } }
    }
    if (offline) {
      throw new Error('offline')
    }
    return {
      data: [
        {
          model: saved.model,
          supportedReasoningEfforts: [],
          ...(child?.tiers ? { additionalSpeedTiers: child.tiers } : {})
        }
      ],
      nextCursor: null
    }
  })
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
    reportedOptions: child?.reported ? { serviceTier: child.reported, serviceTierKnown: true } : {},
    appliedTurnOptions: {
      ...(saved.model ? { model: saved.model } : {}),
      ...(child?.reported ? { serviceTier: child.reported } : {})
    },
    catalogAccess: { store, fingerprint: 'codex-account', accountHomePath: '/account' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
  const shown = child
    ? (await readLiveCodexSessionOptions(session, undefined)).current.serviceTier
    : undefined
  if (child) {
    offline = true
    await store.refresh('codex-account', 'codex', () => Promise.reject(new Error('offline')))
  }
  observeProjection?.(await resolvedCodexMessageOptions(session, saved))
  await startCodexTurn(session, {
    clientMessageId: 'message-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  })
  const firstTurn = request.mock.calls.find(([method]) => method === 'turn/start')?.[1]
  await readLiveCodexSessionOptions(session, undefined)
  return {
    firstTurn: firstTurn?.serviceTier,
    afterLiveRead: session.options.get('serviceTier'),
    ...(child ? { shown } : {})
  }
}

/** Older hosts omit the defaulted marker. */
function answered(saved: Record<string, string>, marksDefaults: boolean) {
  return applyStructuredAgentSessionOptions(
    applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      { origin: 'probe', models: MODELS, fetchedAt: 1 },
      { newLaunch: false, coherentCatalog: true }
    ),
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
  it('uses installed tiers through discovery failure, retaining only reported opaque exceptions', async () => {
    for (const [child, tier, runs] of [
      [{ tiers: ['priority'] }, 'priority', 'default'],
      [{ tiers: ['ultrafast'] }, 'priority', 'default'],
      [{}, 'priority', 'default'],
      [{ tiers: [] }, 'priority', 'default'],
      [{ tiers: [], reported: 'opaque' }, 'opaque', 'opaque'],
      [{ tiers: [], reported: 'ultrafast' }, 'ultrafast', 'ultrafast']
    ] as const) {
      await expect(hostRuns({ model: 'm2', serviceTier: tier }, 120_000, child)).resolves.toEqual({
        firstTurn: runs,
        shown: 'reported' in child ? child.reported : undefined,
        afterLiveRead: tier
      })
    }
  })
  it('shows what the host runs, an older host as it sends it, and keeps the saved tier', async () => {
    for (const [saved, shown, olderShown, runs] of [
      [{ model: 'm2', serviceTier: 'priority' }, 'default', 'default', 'default'],
      [{ model: 'm2', serviceTier: 'flex' }, 'default', 'flex', 'default'],
      [{ model: 'm1', serviceTier: 'priority' }, 'priority', 'priority', 'priority']
    ] as const) {
      expect(shownTier(answered(saved, false))).toBe(olderShown)
      for (const ageMs of [0, 2 * 60_000]) {
        await expect(
          hostRuns(saved, ageMs, undefined, (projected) => {
            expect(projected).toBeDefined()
            expect(shownTier(answered({ ...saved, ...projected }, true))).toBe(shown)
          })
        ).resolves.toEqual({
          firstTurn: runs,
          afterLiveRead: saved.serviceTier
        })
      }
    }
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
