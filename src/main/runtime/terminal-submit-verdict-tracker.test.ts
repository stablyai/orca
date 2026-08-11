import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import {
  TerminalSubmitVerdictTracker,
  type AgentSubmitHookEvent
} from './terminal-submit-verdict-tracker'

const PANE = 'tab-1:leaf-1'
const BOUND_MS = 20

function idleClaudeTurn(overrides: Partial<AgentSubmitHookEvent> = {}): AgentSubmitHookEvent {
  return { paneKey: PANE, source: 'claude', hookEventName: 'Stop', state: 'done', ...overrides }
}

describe('TerminalSubmitVerdictTracker', () => {
  it('reports submitted when the harness announces a turn start after the write', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn())

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent(
      idleClaudeTurn({
        hookEventName: 'UserPromptSubmit',
        state: 'working',
        hasExplicitPrompt: true
      })
    )

    expect(await watch.settle(BOUND_MS)).toMatchObject({
      status: 'submitted',
      reason: 'turn-start-observed'
    })
  })

  it('reports pending when a talkative harness was idle and said nothing', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn())

    const verdict = await tracker.beginWatch(PANE).settle(BOUND_MS)

    expect(verdict).toMatchObject({ status: 'pending', reason: 'no-turn-start-observed' })
    expect(verdict.waitedMs).toBeGreaterThanOrEqual(0)
  })

  it('reports queued when OpenCode accepts the message during a running turn', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'opencode',
      hookEventName: 'MessagePart',
      state: 'working'
    })

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'opencode',
      hookEventName: 'MessagePart',
      hasExplicitPrompt: true,
      state: 'working'
    })

    expect(await watch.settle(BOUND_MS)).toMatchObject({
      status: 'queued',
      reason: 'accepted-mid-turn'
    })
  })

  it('reports submitted when OpenCode accepts the message while idle', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'opencode',
      hookEventName: 'MessagePart',
      state: 'done'
    })

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'opencode',
      hookEventName: 'MessagePart',
      hasExplicitPrompt: true,
      state: 'done'
    })

    expect(await watch.settle(BOUND_MS)).toMatchObject({
      status: 'submitted',
      reason: 'message-accepted'
    })
  })

  it('reports unknown when no live hook event has ever arrived for the pane', async () => {
    const tracker = new TerminalSubmitVerdictTracker()

    expect(await tracker.beginWatch(PANE).settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'no-live-hook-evidence'
    })
  })

  it('reports unknown for a harness with no turn-start signal', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'command-code',
      hookEventName: 'Stop',
      state: 'done'
    })

    expect(await tracker.beginWatch(PANE).settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'harness-has-no-turn-start-signal'
    })
  })

  it('reports unknown, not pending, when the pane was mid-turn', async () => {
    // Why: harnesses that queue mid-turn input act on it when the current turn ends, which can be
    // minutes away. Silence inside the bound is not evidence the Enter was swallowed.
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn({ hookEventName: 'PreToolUse', state: 'working' }))

    expect(await tracker.beginWatch(PANE).settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'sent-mid-turn'
    })
  })

  it('does not claim a mid-turn continuation that carries no submitted prompt', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'hermes',
      hookEventName: 'pre_llm_call',
      state: 'working'
    })

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent({
      paneKey: PANE,
      source: 'hermes',
      hookEventName: 'pre_llm_call',
      state: 'working'
    })

    expect(await watch.settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'sent-mid-turn'
    })
  })

  it('never promotes replayed or restored rows to evidence', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn({ isReplay: true }))
    tracker.noteHookEvent(idleClaudeTurn({ restoredUnconfirmed: true }))

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent(
      idleClaudeTurn({ hookEventName: 'UserPromptSubmit', state: 'working', isReplay: true })
    )

    expect(await watch.settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'no-live-hook-evidence'
    })
  })

  it('treats hook evidence older than the staleness bound as no evidence', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    const observedAt = 1_000_000
    tracker.noteHookEvent(idleClaudeTurn(), observedAt)

    const fresh = tracker.beginWatch(PANE, observedAt + AGENT_STATUS_STALE_AFTER_MS)
    const stale = tracker.beginWatch(PANE, observedAt + AGENT_STATUS_STALE_AFTER_MS + 1)

    expect(await fresh.settle(BOUND_MS)).toMatchObject({ status: 'pending' })
    expect(await stale.settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'no-live-hook-evidence'
    })
  })

  it('ignores a turn start reported by a different pane', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn())

    const watch = tracker.beginWatch(PANE)
    tracker.noteHookEvent(
      idleClaudeTurn({
        paneKey: 'tab-2:leaf-9',
        hookEventName: 'UserPromptSubmit',
        state: 'working'
      })
    )

    expect(await watch.settle(BOUND_MS)).toMatchObject({ status: 'pending' })
  })

  it('reports unknown for a handle with no pane identity', async () => {
    const tracker = new TerminalSubmitVerdictTracker()

    expect(await tracker.beginWatch(null).settle(BOUND_MS)).toMatchObject({
      status: 'unknown',
      reason: 'no-pane-identity'
    })
  })

  it('accumulates waited time across a re-settle and resolves on late evidence', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn())

    const watch = tracker.beginWatch(PANE)
    const first = await watch.settle(BOUND_MS)
    expect(first.status).toBe('pending')

    tracker.noteHookEvent(idleClaudeTurn({ hookEventName: 'UserPromptSubmit', state: 'working' }))
    const second = await watch.settle(BOUND_MS)

    expect(second.status).toBe('submitted')
    expect(second.waitedMs).toBeGreaterThanOrEqual(first.waitedMs)
  })

  it('stops answering once released', async () => {
    const tracker = new TerminalSubmitVerdictTracker()
    tracker.noteHookEvent(idleClaudeTurn())

    const watch = tracker.beginWatch(PANE)
    watch.release()
    tracker.noteHookEvent(idleClaudeTurn({ hookEventName: 'UserPromptSubmit', state: 'working' }))

    expect(await watch.settle(BOUND_MS)).toMatchObject({ status: 'pending' })
  })
})
