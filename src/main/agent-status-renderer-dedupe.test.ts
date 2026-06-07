import { describe, expect, it } from 'vitest'
import { AgentStatusRendererDedupe } from './agent-status-renderer-dedupe'
import type { AgentStatusIpcPayload } from '../shared/agent-status-types'

function status(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'working',
    prompt: 'fix it',
    agentType: 'opencode',
    connectionId: null,
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    ...overrides
  }
}

describe('AgentStatusRendererDedupe', () => {
  it('suppresses duplicate working frames inside the renderer pressure window', () => {
    const dedupe = new AgentStatusRendererDedupe({ windowMs: 1_000 })

    expect(dedupe.shouldSend(status({ receivedAt: 1_000 }), 1_000)).toBe(true)
    expect(dedupe.shouldSend(status({ receivedAt: 1_100 }), 1_100)).toBe(false)
  })

  it('sends state changes immediately', () => {
    const dedupe = new AgentStatusRendererDedupe({ windowMs: 1_000 })

    expect(dedupe.shouldSend(status({ state: 'working' }), 1_000)).toBe(true)
    expect(dedupe.shouldSend(status({ state: 'done' }), 1_100)).toBe(true)
  })

  it('allows periodic keepalive frames for unchanged long-running work', () => {
    const dedupe = new AgentStatusRendererDedupe({ windowMs: 1_000 })

    expect(dedupe.shouldSend(status(), 1_000)).toBe(true)
    expect(dedupe.shouldSend(status(), 2_001)).toBe(true)
  })

  it('sends renderer-visible assistant message changes immediately', () => {
    const dedupe = new AgentStatusRendererDedupe({ windowMs: 1_000 })

    expect(dedupe.shouldSend(status({ lastAssistantMessage: 'first preview' }), 1_000)).toBe(true)
    expect(dedupe.shouldSend(status({ lastAssistantMessage: 'second preview' }), 1_100)).toBe(true)
  })

  it('collapses burst duplicates without suppressing tool preview changes', () => {
    const dedupe = new AgentStatusRendererDedupe({ windowMs: 1_000 })
    let sent = 0

    for (let i = 0; i < 250; i += 1) {
      if (dedupe.shouldSend(status({ toolName: 'Bash', toolInput: 'pnpm test' }), 1_000 + i)) {
        sent += 1
      }
    }

    expect(sent).toBe(1)
    expect(
      dedupe.shouldSend(status({ toolName: 'Bash', toolInput: 'pnpm typecheck' }), 1_250)
    ).toBe(true)
  })
})
