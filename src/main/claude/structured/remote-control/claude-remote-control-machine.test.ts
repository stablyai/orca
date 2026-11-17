import { describe, expect, it } from 'vitest'
import {
  advanceClaudeRemoteControl,
  claudeRemoteControlView,
  CLAUDE_REMOTE_CONTROL_OFF,
  type ClaudeRemoteControlEvent,
  type ClaudeRemoteControlPhase,
  type ClaudeRemoteControlTransition
} from './claude-remote-control-machine'

function run(events: ClaudeRemoteControlEvent[]): ClaudeRemoteControlTransition[] {
  const steps: ClaudeRemoteControlTransition[] = []
  let phase: ClaudeRemoteControlPhase = CLAUDE_REMOTE_CONTROL_OFF
  for (const event of events) {
    const step = advanceClaudeRemoteControl(phase, event)
    steps.push(step)
    phase = step.phase
  }
  return steps
}

const last = (events: ClaudeRemoteControlEvent[]) => run(events).at(-1)!.phase

describe('Claude Remote Control link', () => {
  it('connects through the answer and the bridge, showing connecting until Claude says connected', () => {
    const steps = run([
      { type: 'connect', enabledByDefault: false },
      { type: 'answered', generation: 1, sessionUrl: 'https://claude.ai/code/session_1' },
      { type: 'bridge', state: 'ready' },
      { type: 'bridge', state: 'connected' }
    ])
    expect(steps[0].effect).toEqual({ kind: 'enable', generation: 1 })
    expect(steps.map((step) => claudeRemoteControlView(step.phase)?.state)).toEqual([
      'connecting',
      'connecting',
      'connecting',
      'connected'
    ])
    expect(claudeRemoteControlView(steps[3].phase)).toEqual({
      state: 'connected',
      sessionUrl: 'https://claude.ai/code/session_1'
    })
  })

  it('keeps a link the bridge already connected when the answer arrives after it', () => {
    expect(
      claudeRemoteControlView(
        last([
          { type: 'connect', enabledByDefault: false },
          { type: 'bridge', state: 'connected' },
          { type: 'answered', generation: 1, sessionUrl: 'https://claude.ai/code/session_1' }
        ])
      )
    ).toEqual({ state: 'connected', sessionUrl: 'https://claude.ai/code/session_1' })
  })

  it('ignores a late answer to a connect the person reversed, and ends off once the disable answers', () => {
    const steps = run([
      { type: 'connect', enabledByDefault: false },
      { type: 'disconnect' },
      { type: 'answered', generation: 1, sessionUrl: 'https://claude.ai/code/stale' },
      { type: 'bridge', state: 'connected' },
      { type: 'disconnected', generation: 2 }
    ])
    expect(steps[1].effect).toEqual({ kind: 'disable', generation: 2 })
    expect(steps.slice(1).map((step) => claudeRemoteControlView(step.phase))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(steps[4].phase).toEqual({ kind: 'off', generation: 2 })
  })

  it('restores what Claude proved during a refused disconnect, so the link is not left half-connected', () => {
    const restored = last([
      { type: 'connect', enabledByDefault: false },
      { type: 'disconnect' },
      { type: 'bridge', state: 'connected' },
      { type: 'answered', generation: 1, sessionUrl: 'https://claude.ai/code/session_1' },
      { type: 'disconnect-refused', generation: 2 }
    ])
    expect(claudeRemoteControlView(restored)).toEqual({
      state: 'connected',
      sessionUrl: 'https://claude.ai/code/session_1'
    })
  })

  it('reports a failure and follows Claude when it recovers on its own', () => {
    const failed = last([
      { type: 'connect', enabledByDefault: false },
      { type: 'bridge', state: 'connected' },
      { type: 'bridge', state: 'failed', detail: 'network unreachable' }
    ])
    expect(claudeRemoteControlView(failed)).toEqual({
      state: 'failed',
      detail: 'network unreachable'
    })
    expect(
      claudeRemoteControlView(
        advanceClaudeRemoteControl(failed, { type: 'bridge', state: 'connected' }).phase
      )
    ).toEqual({ state: 'connected' })
  })

  it('retries a refused connect with a new generation', () => {
    const refused = last([
      { type: 'connect', enabledByDefault: false },
      {
        type: 'refused',
        generation: 1,
        detail: 'Remote Control requires claude.ai subscription auth'
      }
    ])
    expect(claudeRemoteControlView(refused)?.state).toBe('failed')
    expect(
      advanceClaudeRemoteControl(refused, { type: 'connect', enabledByDefault: false })
    ).toEqual({
      phase: { kind: 'requesting', generation: 2, enabledByDefault: false },
      effect: { kind: 'enable', generation: 2 }
    })
  })

  it('shows a policy refusal, and turning it off sends nothing because no link exists', () => {
    const disabled = last([
      { type: 'connect', enabledByDefault: false },
      { type: 'bridge', state: 'policy_disabled', detail: 'Disabled by your organization' }
    ])
    expect(claudeRemoteControlView(disabled)).toEqual({
      state: 'policy-disabled',
      detail: 'Disabled by your organization'
    })
    expect(advanceClaudeRemoteControl(disabled, { type: 'disconnect' })).toEqual({
      phase: { kind: 'off', generation: 1 }
    })
  })

  it('sends one request however often connect repeats while a link is up', () => {
    const steps = run([
      { type: 'connect', enabledByDefault: false },
      { type: 'connect', enabledByDefault: false },
      { type: 'bridge', state: 'connected' },
      { type: 'connect', enabledByDefault: false }
    ])
    expect(steps.filter((step) => step.effect).length).toBe(1)
  })

  it('drops the link when the Claude process exits and ignores its frames after that', () => {
    const exited = last([
      { type: 'connect', enabledByDefault: false },
      { type: 'bridge', state: 'connected' },
      { type: 'exited' },
      { type: 'bridge', state: 'connected' },
      { type: 'answered', generation: 1, sessionUrl: 'https://claude.ai/code/stale' }
    ])
    expect(claudeRemoteControlView(exited)).toBeUndefined()
  })

  it('leaves the link alone on a bridge state it does not know', () => {
    const connected = last([
      { type: 'connect', enabledByDefault: false },
      { type: 'bridge', state: 'connected' }
    ])
    expect(advanceClaudeRemoteControl(connected, { type: 'bridge', state: 'paused' }).phase).toBe(
      connected
    )
  })
})
