import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const HOOK_ENV = { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' }

/** Drives the REAL generated extension source into the REAL listener entry, so the pane state
 *  asserted here is the one a pi pane would actually show. */
function createHarness(kind: 'pi' | 'omp' | 'prime-agent' = 'pi') {
  const state = createHookListenerState()
  const states: (string | undefined)[] = []
  const harness = createAgentStatusExtensionHarness({
    kind,
    env: HOOK_ENV,
    fetchImpl: async (_url, init) => {
      const event = normalizeHookPayload(
        state,
        kind === 'prime-agent' ? 'prime-agent' : kind,
        JSON.parse(String(init?.body)),
        'production'
      )
      if (event) {
        state.lastStatusByPaneKey.set(PANE_KEY, event)
      }
      states.push(event?.payload.state)
      return { ok: true }
    }
  })
  return { ...harness, states }
}

async function flushPosts(): Promise<void> {
  // Why: `agent_end` defers its post through a 0ms idle recheck, so microtask flushes alone
  // would read the pane before the parent's own completion was ever delivered.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function drive(
  harness: ReturnType<typeof createHarness>,
  name: string,
  event: unknown = {},
  context: HookContext = { isIdle: () => true }
): Promise<void> {
  await harness.callHook(name, event, context)
  await flushPosts()
}

async function emit(
  harness: ReturnType<typeof createHarness>,
  name: string,
  payload: unknown
): Promise<void> {
  harness.emitProcessBus(name, payload)
  await flushPosts()
}

/** Emit several bus events with NO flush between them, so every one after the first lands
 *  while a delivery is already in flight — the window where the transport's latest-only slot
 *  discards the pending message. Awaiting between emits would flush that window every time
 *  and the race would never be exercised. */
async function emitWithoutFlush(
  harness: ReturnType<typeof createHarness>,
  events: readonly { name: string; payload: unknown }[]
): Promise<void> {
  for (const event of events) {
    harness.emitProcessBus(event.name, event.payload)
  }
  await flushPosts()
}

describe('pi async subagent runs reach the pane as descendants (STA-6378)', () => {
  it('holds the pane working while an async child run outlives the parent turn', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1', agentType: 'researcher' })

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('settles only after the last child, then only once for the turn it wakes', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1' })
    await emit(harness, 'subagent:async-started', { runId: 'run-2' })

    await drive(harness, 'agent_end', {})
    await emit(harness, 'subagent:async-complete', { runId: 'run-1' })
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-2' })
    expect(harness.states.at(-1)).toBe('done')

    // The final child woke the parent for another turn; the pane must not stay settled.
    await drive(harness, 'agent_start')
    expect(harness.states.at(-1)).toBe('working')
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')

    expect(harness.states.filter((value) => value === 'done')).toHaveLength(2)
  })

  it('settles when several children finish inside one in-flight delivery window', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out wide' })
    await drive(harness, 'agent_start')
    // Why: the starts are delivered one at a time on purpose. Coalescing them too would drop
    // the start that pairs with a dropped completion, and the two losses would cancel out —
    // the pane would settle for the wrong reason and the test would prove nothing.
    await emit(harness, 'subagent:async-started', { runId: 'run-1' })
    await emit(harness, 'subagent:async-started', { runId: 'run-2' })
    await emit(harness, 'subagent:async-started', { runId: 'run-3' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    // Why: the transport coalesces to a latest-only slot, so of these three only the last
    // is ever delivered. It carries the whole live set, so the pane still settles; a
    // start/complete delta would strand run-1 and run-2 and pin the pane working forever.
    await emitWithoutFlush(harness, [
      { name: 'subagent:async-complete', payload: { runId: 'run-1' } },
      { name: 'subagent:async-complete', payload: { runId: 'run-2' } },
      { name: 'subagent:async-complete', payload: { runId: 'run-3' } }
    ])
    expect(harness.states.at(-1)).toBe('done')
  })

  it('keeps the pane working when only some of a coalesced burst finish', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'partial' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1' })
    await emit(harness, 'subagent:async-started', { runId: 'run-2' })
    await drive(harness, 'agent_end', {})

    await emitWithoutFlush(harness, [
      { name: 'subagent:async-complete', payload: { runId: 'run-1' } }
    ])
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-2' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('survives an in-process reload without forgetting live children', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'reload me' })
    await drive(harness, 'agent_start')
    await emit(harness, 'subagent:async-started', { runId: 'run-1' })

    // Why: the posted set is authoritative, so a reload that rebuilt it empty would tell the
    // receiver the child had finished. The set lives at module scope for exactly this reason.
    harness.reload()
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, 'subagent:async-complete', { runId: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('ignores a bus payload with no run id rather than inventing a child', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'go' })
    await drive(harness, 'agent_start')
    const before = harness.states.length

    await emit(harness, 'subagent:async-started', { note: 'no id here' })
    expect(harness.states).toHaveLength(before)

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')
  })

  it('binds the process bus once across an in-process extension reload', () => {
    const harness = createHarness()
    expect(harness.processBusListenerCount('subagent:async-started')).toBe(1)
    harness.reload()
    // Why: pi replaces pi.on handlers on reload but not process-bus listeners; a second
    // registration would post every async child event twice.
    expect(harness.processBusListenerCount('subagent:async-started')).toBe(1)
  })

  it('does not register the pi subagent bus for omp or prime-agent', () => {
    expect(createHarness('omp').processBusListenerCount('subagent:async-started')).toBe(0)
    expect(createHarness('prime-agent').processBusListenerCount('subagent:async-started')).toBe(0)
  })
})
