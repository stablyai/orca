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

  it('reads each submission instant by client message id', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('stale-unknown', 100)
    echoes.arm('later-turn', 200)

    expect(echoes.requestOrigin('later-turn')).toEqual({ requestedAt: 200, sequence: 1 })
    expect(echoes.requestOrigin('stale-unknown')).toEqual({ requestedAt: 100, sequence: 0 })
    expect(echoes.requestOrigin('never-armed')).toBeNull()
    expect(echoes.latestSequence()).toBe(1)
  })

  it('keeps one causal sequence when an unconfirmed send retries', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1', 100)
    echoes.arm('client-1', 200)

    expect(echoes.requestOrigin('client-1')).toEqual({ requestedAt: 100, sequence: 0 })
    expect(echoes.latestSequence()).toBe(0)
  })

  it('retires only sends bound to the terminal turn', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.arm('client-2')
    expect(echoes.bindSteerResponse('client-1', 'turn-1', 'turn-1')).toBe(true)
    expect(echoes.bindSteerResponse('client-2', 'turn-2', 'turn-2')).toBe(true)

    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])
    echoes.commitTerminal('turn-1')

    expect(echoes.settle('client-1')).toBe(true)
    expect(echoes.settle('client-2')).toBe(true)
  })

  it('late-settles an exact steer response after its terminal notification', async () => {
    const ownerEndedLate: [string, string][] = []
    const echoes = createCodexDispatchEchoes((clientMessageId, turnId) => {
      ownerEndedLate.push([clientMessageId, turnId])
      return Promise.resolve('settled')
    })
    echoes.arm('client-1')

    expect(echoes.terminalOwnerIds('turn-1')).toEqual([])
    echoes.commitTerminal('turn-1')

    expect(echoes.bindSteerResponse('client-1', 'turn-1', 'turn-1')).toBe(true)
    expect(ownerEndedLate).toEqual([['client-1', 'turn-1']])
    await Promise.resolve()
    expect(echoes.size).toBe(0)
    expect(echoes.settle('client-1')).toBe(true)
  })

  it('late-settles a fresh start response after its terminal notification', async () => {
    const ownerEndedLate: [string, string][] = []
    const echoes = createCodexDispatchEchoes((clientMessageId, turnId) => {
      ownerEndedLate.push([clientMessageId, turnId])
      return Promise.resolve('settled')
    })
    echoes.arm('client-1')

    expect(echoes.terminalOwnerIds('turn-1')).toEqual([])
    echoes.commitTerminal('turn-1')
    echoes.recordStartResponse('client-1', 'turn-1')

    expect(ownerEndedLate).toEqual([['client-1', 'turn-1']])
    await Promise.resolve()
    expect(echoes.size).toBe(0)
  })

  it('retains exact ownership when a late settlement is not durable', async () => {
    const echoes = createCodexDispatchEchoes(() => Promise.resolve('evidence-not-durable'))
    echoes.arm('client-1')
    echoes.terminalOwnerIds('turn-1')
    echoes.commitTerminal('turn-1')

    expect(echoes.bindSteerResponse('client-1', 'turn-1', 'turn-1')).toBe(true)
    await Promise.resolve()

    expect(echoes.size).toBe(1)
    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])
  })

  it('re-derives exact owners after a terminal append is rejected', async () => {
    const echoes = createCodexDispatchEchoes(() => Promise.resolve('evidence-not-durable'))
    echoes.arm('known-before-terminal')
    echoes.bindSteerResponse('known-before-terminal', 'turn-1', 'turn-1')
    echoes.arm('response-still-pending')

    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['known-before-terminal'])
    echoes.abandonTerminal('turn-1')
    expect(echoes.bindSteerResponse('response-still-pending', 'turn-1', 'turn-1')).toBe(true)
    await Promise.resolve()

    expect(echoes.terminalOwnerIds('turn-1')).toEqual([
      'known-before-terminal',
      'response-still-pending'
    ])
  })

  it('binds a fresh start only after response and started evidence in either order', () => {
    const responseFirst = createCodexDispatchEchoes()
    responseFirst.arm('client-response-first')
    responseFirst.recordStartResponse('client-response-first', 'turn-response-first')
    expect(responseFirst.terminalOwnerIds('unrelated-turn')).toEqual([])
    responseFirst.commitTerminal('unrelated-turn')
    responseFirst.observeTurnStarted('turn-response-first')
    expect(responseFirst.terminalOwnerIds('turn-response-first')).toEqual(['client-response-first'])

    const startedFirst = createCodexDispatchEchoes()
    startedFirst.arm('client-started-first')
    startedFirst.observeTurnStarted('turn-started-first')
    startedFirst.recordStartResponse('client-started-first', 'turn-started-first')
    expect(startedFirst.terminalOwnerIds('turn-started-first')).toEqual(['client-started-first'])
  })

  it('leaves a response-only phantom start awaiting its echo', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.recordStartResponse('client-1', 'phantom-turn')

    expect(echoes.terminalOwnerIds('active-turn')).toEqual([])
    echoes.commitTerminal('active-turn')
    expect(echoes.size).toBe(1)
    expect(echoes.settle('client-1')).toBe(true)
  })

  it('keeps a terminal snapshot stable across a retried append', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindSteerResponse('client-1', 'turn-1', 'turn-1')

    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])
    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])
    echoes.commitTerminal('turn-1')

    expect(echoes.size).toBe(0)
    expect(echoes.settle('client-1')).toBe(true)
  })

  it('releases a failed snapshot without losing exact ownership or echo recovery', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')
    echoes.bindSteerResponse('client-1', 'turn-1', 'turn-1')
    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])

    echoes.abandonTerminal('turn-1')

    expect(echoes.terminalOwnerIds('turn-1')).toEqual(['client-1'])
    expect(echoes.settle('client-1')).toBe(true)
  })

  it('refuses an echo this session never armed', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1')

    expect(echoes.settle('client-from-history')).toBe(false)
    expect(echoes.size).toBe(1)
  })

  it('settles a send exactly once', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('client-1', 100)

    expect(echoes.settle('client-1')).toBe(true)
    expect(echoes.settle('client-1')).toBe(false)
    expect(echoes.requestOrigin('client-1')).toEqual({ requestedAt: 100, sequence: 0 })
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

  it('leaves overflow untracked without dropping an older send', () => {
    const echoes = createCodexDispatchEchoes()
    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      expect(echoes.arm(`client-${index}`)).toBe(true)
    }

    expect(echoes.arm(`client-${MAX_CODEX_PENDING_DISPATCH_ECHOES}`)).toBe(false)
    expect(echoes.size).toBe(MAX_CODEX_PENDING_DISPATCH_ECHOES)
    expect(echoes.settle('client-0')).toBe(true)
    expect(echoes.settle(`client-${MAX_CODEX_PENDING_DISPATCH_ECHOES}`)).toBe(false)
  })

  it('bounds retired late-echo correlations without consuming live capacity', () => {
    const echoes = createCodexDispatchEchoes()
    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      echoes.arm(`old-${index}`)
      echoes.bindSteerResponse(`old-${index}`, 'turn-old', 'turn-old')
    }
    echoes.terminalOwnerIds('turn-old')
    echoes.commitTerminal('turn-old')

    for (let index = 0; index < MAX_CODEX_PENDING_DISPATCH_ECHOES; index += 1) {
      expect(echoes.arm(`new-${index}`)).toBe(true)
      echoes.bindSteerResponse(`new-${index}`, 'turn-new', 'turn-new')
    }
    echoes.terminalOwnerIds('turn-new')
    echoes.commitTerminal('turn-new')

    expect(echoes.size).toBe(0)
    expect(echoes.settle('old-0')).toBe(false)
    expect(echoes.settle('new-0')).toBe(true)
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
