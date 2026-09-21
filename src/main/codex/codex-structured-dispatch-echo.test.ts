import { describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import {
  createCodexDispatchEchoes,
  readCodexDispatchEcho,
  MAX_CODEX_PENDING_DISPATCH_ECHOES
} from './codex-structured-dispatch-echo'

const CODEX_IDENTITY: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 3
}

describe('codex dispatch echoes', () => {
  it('settles by client message id rather than arrival order', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.arm('client-2')

    // Codex coalesces both sends into one turn, and the second can be echoed
    // first. Queue position would settle the wrong submission here.
    expect(echoes.settle('client-2')).toBe(true)
    expect(echoes.settle('client-1')).toBe(true)
    expect(echoes.size).toBe(0)
  })

  it('refuses an echo this session never armed', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')

    expect(echoes.settle('client-from-history')).toBe(false)
    expect(echoes.size).toBe(1)
  })

  it('settles a send exactly once', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')

    expect(echoes.settle('client-1')).toBe(true)
    expect(echoes.settle('client-1')).toBe(false)
  })

  it('drops a send whose write never reached the provider', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.disarm('client-1')

    expect(echoes.settle('client-1')).toBe(false)
  })

  it('clears every armed send', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.arm('client-2')

    echoes.clear()

    expect(echoes.size).toBe(0)
    expect(echoes.settle('client-1')).toBe(false)
  })

  it('refuses new correlations at capacity without dropping an older send', () => {
    const echoes = createCodexDispatchEchoes()
    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      expect(echoes.arm(`client-${index}`)).toBe(true)
    }

    expect(echoes.arm(`client-${MAX_CODEX_PENDING_DISPATCH_ECHOES}`)).toBe(false)
    expect(echoes.size).toBe(MAX_CODEX_PENDING_DISPATCH_ECHOES)
    expect(echoes.settle('client-0')).toBe(true)
    expect(echoes.settle(`client-${MAX_CODEX_PENDING_DISPATCH_ECHOES}`)).toBe(false)
  })
})

describe('readCodexDispatchEcho', () => {
  it('reads the client message id off a user message', () => {
    expect(
      readCodexDispatchEcho(
        { type: 'userMessage', id: 'item-1', clientId: 'client-1' },
        CODEX_IDENTITY
      )
    ).toEqual({ clientMessageId: 'client-1', providerIdentity: CODEX_IDENTITY })
  })

  it('ignores an item that is not a user message', () => {
    expect(
      readCodexDispatchEcho(
        { type: 'agentMessage', id: 'item-1', clientId: 'client-1' },
        CODEX_IDENTITY
      )
    ).toBeNull()
  })

  it('ignores a user message Codex did not correlate', () => {
    expect(readCodexDispatchEcho({ type: 'userMessage', id: 'item-1' }, CODEX_IDENTITY)).toBeNull()
  })

  it('ignores an item with no durable Codex identity', () => {
    expect(
      readCodexDispatchEcho(
        { type: 'userMessage', id: 'item-1', clientId: 'client-1' },
        { provider: 'orca', clientMessageId: 'codex-item:thread-1:item-1' }
      )
    ).toBeNull()
  })
})
