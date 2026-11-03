import { describe, expect, it } from 'vitest'

import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import { seedClaudeSubagentRosterFromSnapshots } from '../../shared/agent-hook-listener/providers/claude-roster-state'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../../shared/stable-pane-id'
import { CLAUDE_HOOK_EVENT_FIRST_VERSIONS } from './claude-hook-event-versions'
import { CLAUDE_EVENTS, getClaudeManagedHookPlan } from './claude-managed-hook-events'
import { applyManagedHooks } from './hook-settings'

const PANE_KEY = makePaneKey('compact-registration', '11111111-1111-4111-8111-111111111111')
const TURN_PROMPT_ID = '22222222-2222-4222-8222-222222222222'
const COMPACT_PROMPT_ID = '33333333-3333-4333-8333-333333333333'

const REGISTERED_EVENT_NAMES = new Set<string>(CLAUDE_EVENTS.map((event) => event.eventName))

/** Gate delivery on registration so tests cannot exercise hooks Claude never emits to Orca. */
function deliverIfRegistered(
  state: HookListenerState,
  payload: Record<string, unknown>
): AgentHookEventPayload | null {
  if (!REGISTERED_EVENT_NAMES.has(payload.hook_event_name as string)) {
    return null
  }
  const event = normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
  if (event) {
    seedLegacyAgentStatusForTests(state, event)
  }
  return event
}

function hook(name: string, promptId: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: name, prompt_id: promptId, session_id: 'session-a', ...extra }
}

/** Manual /compact sequence captured from a PTY-driven Claude Code 2.1.227 session. */
function successfulManualCompact(state: HookListenerState) {
  deliverIfRegistered(state, hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
  deliverIfRegistered(
    state,
    hook('SubagentStop', COMPACT_PROMPT_ID, {
      agent_id: 'a75b38b59774e1f31',
      agent_type: '',
      background_tasks: [],
      session_crons: []
    })
  )
  deliverIfRegistered(state, hook('SessionStart', COMPACT_PROMPT_ID, { source: 'compact' }))
  return deliverIfRegistered(state, hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
}

function startTurn(state: HookListenerState) {
  deliverIfRegistered(state, hook('UserPromptSubmit', TURN_PROMPT_ID, { prompt: 'do the thing' }))
}

/** Reproduce a hydrated working row, optionally with a child known only from a disk snapshot. */
function hydrateStuckRow(
  state: HookListenerState,
  options: { withRestoredChild?: boolean; providerSession?: boolean } = {}
): void {
  const subagents = options.withRestoredChild
    ? [{ id: 'child-1', state: 'working' as const, startedAt: 0, agentType: 'general' }]
    : undefined
  const hydrated = {
    paneKey: PANE_KEY,
    source: 'claude',
    connectionId: 'a-previous-connection',
    hookEventName: 'UserPromptSubmit',
    providerPromptId: TURN_PROMPT_ID,
    ...(options.providerSession === false
      ? {}
      : { providerSession: { key: 'session_id', id: 'session-a' } }),
    restoredUnconfirmed: true,
    payload: {
      state: 'working',
      prompt: 'work before the restart',
      agentType: 'claude',
      ...(subagents ? { subagents } : {})
    }
  } as unknown as AgentHookEventPayload
  seedLegacyAgentStatusForTests(state, hydrated)
  if (subagents) {
    seedClaudeSubagentRosterFromSnapshots(state, PANE_KEY, subagents)
  }
}

describe('Claude compact hook registration', () => {
  it('writes PostCompact, and no PreCompact, into the settings Claude actually reads', () => {
    const written = applyManagedHooks(
      { hooks: {} },
      () => ({ type: 'command', command: 'orca-claude-hook' }),
      'claude-hook.sh',
      getClaudeManagedHookPlan(CLAUDE_HOOK_EVENT_FIRST_VERSIONS.PostCompact)
    )
    const postCompact = written.hooks?.PostCompact ?? []
    expect(
      postCompact.some((definition) =>
        (definition.hooks ?? []).some((entry) => entry.command === 'orca-claude-hook')
      )
    ).toBe(true)
    expect(written.hooks?.PreCompact).toBeUndefined()
  })
})

describe('STA-2915: a manual compact clears the pane', () => {
  it('ends a stuck working row as a silent done', () => {
    const state = createHookListenerState()
    startTurn(state)
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    const completion = successfulManualCompact(state)

    expect(completion?.payload.state).toBe('done')
    // Session boundaries must not trigger turn-completion automations, unread counts, or notifications.
    expect(completion?.payload.sessionBoundary).toBe(true)
  })

  it('keeps the summarizer SubagentStop from being the thing that resolves the pane', () => {
    const state = createHookListenerState()
    startTurn(state)
    const republished = deliverIfRegistered(
      state,
      hook('SubagentStop', COMPACT_PROMPT_ID, {
        agent_id: 'a75b38b59774e1f31',
        agent_type: '',
        background_tasks: [],
        session_crons: []
      })
    )
    expect(republished?.payload.state).toBe('working')
  })
})

describe('STA-4613: an aborted compact must not strand the pane', () => {
  it('does not map PreCompact even when it is delivered past the registration gate', () => {
    const state = createHookListenerState()
    startTurn(state)
    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID))

    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
      },
      'production'
    )

    expect(event).toBeNull()
  })
})

describe('an auto compact claims nothing', () => {
  it('leaves the in-flight turn alone and lets its own Stop close it', () => {
    const state = createHookListenerState()
    startTurn(state)

    const autoCompact = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'auto' })
    )

    expect(autoCompact).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID))
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
  })
})

describe('STA-2915: the pane the ticket actually reports', () => {
  it('clears a row stuck behind a child that exists only as a disk snapshot', () => {
    const state = createHookListenerState()
    hydrateStuckRow(state, { withRestoredChild: true })

    deliverIfRegistered(state, hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    // Keep the hydrated row as owner so completion exercises restored-state handling.
    const summarizer = deliverIfRegistered(
      state,
      hook('SubagentStop', COMPACT_PROMPT_ID, { agent_id: 'a75b38b59774e1f31', agent_type: '' })
    )
    expect(summarizer).toBeNull()
    deliverIfRegistered(state, hook('SessionStart', COMPACT_PROMPT_ID, { source: 'compact' }))

    const completion = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
    )

    // A restored child snapshot does not prove live work at an idle manual-compaction boundary.
    expect(completion?.payload.state).toBe('done')
    expect(completion?.payload.sessionBoundary).toBe(true)
    expect(completion?.payload.subagents ?? []).toEqual([])
  })

  it('leaves a pane held by a RUNTIME child at working, and republishes nothing', () => {
    const state = createHookListenerState()
    startTurn(state)
    deliverIfRegistered(state, hook('SubagentStart', TURN_PROMPT_ID, { agent_id: 'child-live' }))
    const before = state.lastStatusByPaneKey.get(PANE_KEY)

    const completion = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
    )

    // Republishing would clear restoredUnconfirmed and reset staleness for work the compact never observed.
    expect(completion).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(before)
    expect(before?.payload.state).toBe('working')
  })

  it('leaves a pane held by an active session cron at working, and republishes nothing', () => {
    const state = createHookListenerState()
    startTurn(state)
    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID, { session_crons: [{ id: 'cron-1' }] }))
    const before = state.lastStatusByPaneKey.get(PANE_KEY)
    expect(before?.payload.state).toBe('working')

    expect(
      deliverIfRegistered(state, hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
    ).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBe(before)
  })
})

describe('compact completion guards', () => {
  it('does not resurrect a pane that was retired before the completion arrived', () => {
    const state = createHookListenerState()
    expect(successfulManualCompact(state)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBeUndefined()
  })

  it('clears a stuck row restored from disk after a restart, despite a stale connection id', () => {
    const state = createHookListenerState()
    hydrateStuckRow(state)
    // Deliver completion alone; a summarizer could replace the hydrated row and bypass this branch.
    const completion = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
    )

    expect(completion?.payload.state).toBe('done')
    expect(completion?.payload.sessionBoundary).toBe(true)
  })

  it('clears a restored row that predates provider-session persistence', () => {
    const state = createHookListenerState()
    hydrateStuckRow(state, { providerSession: false })
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.providerSession).toBeUndefined()

    const completion = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
    )

    expect(completion?.payload.state).toBe('done')
  })

  it('does not clear a live turn owned by a different Claude session', () => {
    const state = createHookListenerState()
    startTurn(state)

    const foreign = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostCompact',
          prompt_id: COMPACT_PROMPT_ID,
          session_id: 'a-different-session',
          trigger: 'manual'
        }
      },
      'production'
    )

    expect(foreign).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
  })

  it('rejects a compact completion with no provider prompt id', () => {
    const state = createHookListenerState()
    startTurn(state)

    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PostCompact', session_id: 'session-a', trigger: 'manual' }
      },
      'production'
    )

    expect(event).toBeNull()
  })

  it('applies a compact completion once, so a duplicate cannot refresh the row', () => {
    const state = createHookListenerState()
    startTurn(state)
    expect(successfulManualCompact(state)?.payload.state).toBe('done')

    const duplicate = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
      },
      'production'
    )

    expect(duplicate).toBeNull()
  })
})
