import { describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { createCodexDispatchEchoes, readCodexDispatchEcho } from './codex-structured-dispatch-echo'

const CODEX_IDENTITY: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 3
}

describe('codex dispatch echoes', () => {
  it('keeps one causal sequence when an unconfirmed send retries', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1', 100)
    echoes.arm('client-1', 200)

    expect(echoes.requestOrigin('client-1')).toEqual({ requestedAt: 100, sequence: 0 })
    expect(echoes.latestSequence()).toBe(0)
  })
})

describe('readCodexDispatchEcho', () => {
  it('ignores an item that is not a user message', () => {
    expect(
      readCodexDispatchEcho(
        { type: 'agentMessage', id: 'item-1', clientId: 'client-1' },
        CODEX_IDENTITY
      )
    ).toBeNull()
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

describe('the turn Codex answered a send into but has not opened', () => {
  const NONE_OPEN = new Set<string>()

  it('is the turn the latest armed send was answered into', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')
    echoes.arm('client-2')
    echoes.bindTurn('client-2', 'thread-1', 'turn-2', 'start')

    expect(echoes.answeredUnopenedTurn('thread-1', NONE_OPEN)).toBe('turn-2')
  })

  it('is none once Codex opened that turn', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')

    expect(echoes.answeredUnopenedTurn('thread-1', new Set(['turn-1']))).toBeNull()
  })

  it('is none once that turn ended, even with its send still armed for an echo', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')
    // A completed end leaves its unechoed send armed.
    expect(echoes.endTurn('thread-1', 'turn-1', { status: 'completed' })).toEqual([])

    expect(echoes.answeredUnopenedTurn('thread-1', NONE_OPEN)).toBeNull()
  })

  it('skips a turn a wait left unopened, and still names an earlier one', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindTurn('client-1', 'thread-1', 'turn-1', 'start')
    echoes.arm('client-2')
    echoes.bindTurn('client-2', 'thread-1', 'turn-2', 'start')

    echoes.leftUnopened('thread-1', 'turn-2')

    expect(echoes.answeredUnopenedTurn('thread-1', NONE_OPEN)).toBe('turn-1')
  })

  it('is none for a send not yet answered, or answered on another thread', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.arm('client-2')
    echoes.bindTurn('client-2', 'thread-2', 'turn-2', 'start')

    expect(echoes.answeredUnopenedTurn('thread-1', NONE_OPEN)).toBeNull()
  })
})

describe('the sends Codex holds', () => {
  const held = (echoes: ReturnType<typeof createCodexDispatchEchoes>) => [...echoes.heldSends()]

  it('holds a send from its write until the turn it was answered into ends, echo or not', () => {
    const changes: string[] = []
    const echoes = createCodexDispatchEchoes(() => changes.push(held(echoes).join(',')))
    echoes.arm('sent')
    expect(held(echoes)).toEqual(['sent'])

    echoes.bindTurn('sent', 'thread-1', 'turn-1', 'start', echoes.tick())
    expect(held(echoes)).toEqual(['sent'])

    // Completed with no echo, as when a hook refused the prompt: no longer Codex's work.
    echoes.endTurn('thread-1', 'turn-1', { status: 'completed' })
    expect(held(echoes)).toEqual([])
    expect(changes).toEqual([''])
  })

  it('holds a send answered into no turn only while a status read after its answer says running', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('timed-out')
    // Idle read while the request is unanswered: Codex may not have read it yet, so it still holds it.
    echoes.observeStatus(false)
    expect(held(echoes)).toEqual(['timed-out'])
    echoes.answered('timed-out', echoes.tick())
    expect(held(echoes)).toEqual([])

    echoes.observeStatus(true)
    expect(held(echoes)).toEqual(['timed-out'])
    echoes.observeStatus(false)
    expect(held(echoes)).toEqual([])
  })

  it('lets a running status read before the answer hold nothing', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('sent')
    echoes.observeStatus(true)
    echoes.answered('sent', echoes.tick())
    expect(held(echoes)).toEqual([])
  })
})
