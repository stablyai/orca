import { describe, expect, it, vi } from 'vitest'
import type {
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import { SshPtyRemoteSourceRangeConsumers } from './ssh-pty-remote-source-range-consumers'
import { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'

const identity: PtySourceDeliveryIdentity = {
  id: 'pty-1',
  providerGeneration: 1,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-1',
  deliveryToken: 'token-1'
}

function span(spanId: string, overrides: Partial<PtySourceSpan> = {}): PtySourceSpan {
  return {
    ...identity,
    spanId,
    sourceStartSu: 0,
    sourceEndSu: 4,
    displayStart: 0,
    displayEnd: 4,
    data: 'data',
    splittable: true,
    transform: { transformed: false, rawLengthSu: 4, scalarSafe: true },
    ...overrides
  }
}

function range(
  spanId: string,
  overrides: Partial<TerminalOutputSourceRange> = {}
): TerminalOutputSourceRange {
  return {
    id: 'pty-1',
    spanId,
    providerGeneration: 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    sourceStartSu: 0,
    sourceEndSu: 4,
    displayStart: 0,
    displayEnd: 4,
    splittable: true,
    transform: { transformed: false, rawLengthSu: 4, scalarSafe: true },
    ...overrides
  }
}

function createCoordinator(): SshPtySourceObligationCoordinator {
  return new SshPtySourceObligationCoordinator({
    publish: vi.fn(),
    schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
    cancelSchedule: vi.fn()
  })
}

describe('SshPtyRemoteSourceRangeConsumers', () => {
  it('snapshots membership and settles only the current stream generation', () => {
    const ledger = createCoordinator()
    const progress = vi.fn()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger, progress)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    expect(consumers.hooks.attach(stream)).toBe(true)
    const sourceSpan = span('span-1')
    const reservation = ledger.reserve(identity, sourceSpan, [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', sourceSpan.spanId, reservation.requiredConsumers, 4)

    consumers.hooks.settle({ ...stream, streamGeneration: 'stale' }, [range('span-1')])
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('open')
    consumers.hooks.settle(stream, [range('span-1')])
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('settled')
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it.each(['headless', 'renderer'] as const)(
    'commits remaining mappings only after a %s snapshot publication',
    (source) => {
      const ledger = createCoordinator()
      const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
      const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
      ledger.open(identity)
      consumers.hooks.attach(stream)
      const reservation = ledger.reserve(identity, span('span-1'), [
        'model',
        ...consumers.requiredConsumers('pty-1')
      ])
      ledger.commit(reservation)
      consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)

      const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')

      expect(replacement).not.toBeNull()
      expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
        state: 'transferring',
        to: 'remote:snapshot:consumer-1'
      })
      expect(consumers.hooks.commitReplacement(replacement!, { source, seq: 3 })).toBe(false)
      expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('transferring')
      expect(consumers.hooks.commitReplacement(replacement!, { source, seq: 4 })).toBe(true)
      expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
        state: 'transferred',
        to: 'remote:snapshot:consumer-1'
      })
      expect(consumers.requiredConsumers('pty-1')).toEqual(['remote:consumer-1'])
    }
  )

  it('reserves only spans covered by the authoritative snapshot sequence', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const covered = ledger.reserve(identity, span('span-covered'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(covered)
    consumers.trackSpan('pty-1', 'span-covered', covered.requiredConsumers, 4)
    const trailingSpan = {
      ...span('span-trailing'),
      sourceStartSu: 4,
      sourceEndSu: 8,
      displayStart: 4,
      displayEnd: 8
    }
    const trailing = ledger.reserve(identity, trailingSpan, [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(trailing)
    consumers.trackSpan('pty-1', 'span-trailing', trailing.requiredConsumers, 8)

    const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')

    expect(replacement).not.toBeNull()
    expect(ledger.obligation('span-covered', 'remote:consumer-1')).toMatchObject({
      state: 'transferring'
    })
    expect(ledger.obligation('span-trailing', 'remote:consumer-1')).toMatchObject({
      state: 'open'
    })
  })

  it('rolls a failed replacement publication back to the live stream obligation', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)

    const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')
    expect(consumers.hooks.rollbackReplacement(replacement!, 'snapshot-write-failed')).toBe(true)

    expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
      state: 'open'
    })
  })

  it('rolls back every transfer when replacement reservation fails partway', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const first = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(first)
    consumers.trackSpan('pty-1', 'span-1', first.requiredConsumers, 4)
    const secondSpan = span('span-2', {
      sourceStartSu: 4,
      sourceEndSu: 8,
      displayStart: 4,
      displayEnd: 8
    })
    const second = ledger.reserve(identity, secondSpan, [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(second)
    consumers.trackSpan('pty-1', 'span-2', second.requiredConsumers, 8)
    const beginTransfer = ledger.beginTransfer.bind(ledger)
    vi.spyOn(ledger, 'beginTransfer').mockImplementation((transition, replacement) => {
      if (transition.spanId === 'span-2') {
        throw new Error('injected partial reserve failure')
      }
      return beginTransfer(transition, replacement)
    })

    expect(() => consumers.hooks.reserveReplacement(stream, 8, 'initial-snapshot')).toThrowError(
      'injected partial reserve failure'
    )
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('open')
    expect(ledger.obligation('span-2', 'remote:consumer-1').state).toBe('open')
  })

  it('rejects a replacement whose exact transfer state changed before commit', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const sourceSpan = span('span-1')
    const admission = ledger.reserve(identity, sourceSpan, [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(admission)
    consumers.trackSpan('pty-1', 'span-1', admission.requiredConsumers, 4)
    const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')!
    const transition = {
      identity: sourceSpan,
      spanId: sourceSpan.spanId,
      consumer: 'remote:consumer-1' as const,
      reason: 'concurrent-replacement'
    }
    expect(ledger.rollbackTransfer(transition)).toBe(true)
    expect(ledger.beginTransfer(transition, 'remote:snapshot:consumer-1')).toBe(true)

    expect(consumers.hooks.commitReplacement(replacement, { source: 'headless', seq: 4 })).toBe(
      false
    )
    expect(consumers.hooks.rollbackReplacement(replacement, 'commit-rejected')).toBe(false)
    expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
      state: 'transferring',
      reason: 'concurrent-replacement'
    })
  })

  it('settles a split source span only after its complete ordered range is acknowledged', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)

    consumers.hooks.settle(stream, [
      range('span-1', {
        sourceEndSu: 2,
        displayEnd: 2,
        transform: { transformed: false, rawLengthSu: 2, scalarSafe: true }
      })
    ])
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('open')

    consumers.hooks.settle(stream, [
      range('span-1', {
        sourceStartSu: 2,
        sourceEndSu: 4,
        displayStart: 2,
        displayEnd: 4,
        transform: { transformed: false, rawLengthSu: 2, scalarSafe: true }
      })
    ])
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('settled')
  })

  it('cancels an admitted span on detach without minting a snapshot owner', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)

    consumers.hooks.cancel(stream, [], 'stream-detached')

    expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
      state: 'canceled',
      reason: 'stream-detached'
    })
    expect(consumers.requiredConsumers('pty-1')).toEqual([])
  })

  it('rolls back a pending replacement before disconnect cancellation', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)
    const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')

    consumers.hooks.cancel(stream, [], 'connection-closed')

    expect(consumers.hooks.commitReplacement(replacement!, { source: 'headless', seq: 4 })).toBe(
      false
    )
    expect(ledger.obligation('span-1', 'remote:consumer-1')).toMatchObject({
      state: 'canceled',
      reason: 'connection-closed'
    })
  })

  it('rejects stale stream generations without changing the current obligation', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)

    expect(() =>
      consumers.hooks.reserveReplacement(
        { ...stream, streamGeneration: 'stale' },
        4,
        'initial-snapshot'
      )
    ).toThrow('stale')
    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('open')
  })

  it('rolls back replacement admission before provider-generation close', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)
    const replacement = consumers.hooks.reserveReplacement(stream, 4, 'initial-snapshot')

    consumers.closeGeneration(identity.providerGeneration, 'provider-replaced')

    expect(ledger.obligation('span-1', 'remote:consumer-1').state).toBe('open')
    expect(consumers.hooks.commitReplacement(replacement!, { source: 'headless', seq: 4 })).toBe(
      false
    )
  })

  it('detaches cleanly after cancellation proof reclaims tracked spans', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)
    ledger.seal(identity)
    ledger.beginExitTimeout(identity)
    ledger.applyCancellationProof(identity, { sentEndSu: 4, creditedEndSu: 0 })

    expect(() => consumers.hooks.settle(stream, [range('span-1')])).not.toThrow()
    expect(() => consumers.hooks.cancel(stream, [], 'stream-detached')).not.toThrow()
    expect(consumers.requiredConsumers('pty-1')).toEqual([])
  })

  it('rejects and rolls back a replacement after proof reclaims its covered spans', () => {
    const ledger = createCoordinator()
    const consumers = new SshPtyRemoteSourceRangeConsumers(ledger)
    const stream = { ptyId: 'pty-1', consumerId: 'consumer-1', streamGeneration: 'stream-1' }
    ledger.open(identity)
    consumers.hooks.attach(stream)
    const reservation = ledger.reserve(identity, span('span-1'), [
      'model',
      ...consumers.requiredConsumers('pty-1')
    ])
    ledger.commit(reservation)
    consumers.trackSpan('pty-1', 'span-1', reservation.requiredConsumers, 4)
    const recoveredIdentity = {
      ...identity,
      clientGeneration: 3,
      ownerGeneration: 4,
      deliveryToken: 'token-2'
    }
    ledger.open(recoveredIdentity, 4)
    const recovered = ledger.reserve(
      recoveredIdentity,
      span('span-2', {
        ...recoveredIdentity,
        sourceStartSu: 4,
        sourceEndSu: 8,
        displayStart: 4,
        displayEnd: 8
      }),
      ['model', ...consumers.requiredConsumers('pty-1')]
    )
    ledger.commit(recovered)
    consumers.trackSpan('pty-1', 'span-2', recovered.requiredConsumers, 8)
    const replacement = consumers.hooks.reserveReplacement(stream, 8, 'initial-snapshot')
    ledger.seal(identity)
    ledger.beginExitTimeout(identity)
    ledger.applyCancellationProof(identity, { sentEndSu: 4, creditedEndSu: 0 })

    const queuedOutput = ['covered-output', 'surviving-output']
    const committed = consumers.hooks.commitReplacement(replacement!, {
      source: 'headless',
      seq: 8
    })
    if (committed) {
      queuedOutput.splice(0)
    }

    expect(committed).toBe(false)
    expect(queuedOutput).toEqual(['covered-output', 'surviving-output'])
    expect(consumers.hooks.rollbackReplacement(replacement!, 'commit-rejected')).toBe(true)
    expect(ledger.obligation('span-2', 'remote:consumer-1').state).toBe('open')
    expect(consumers.hooks.rollbackReplacement(replacement!, 'commit-rejected')).toBe(false)
    expect(() => consumers.hooks.cancel(stream, [], 'stream-detached')).not.toThrow()
    expect(consumers.requiredConsumers('pty-1')).toEqual([])
  })
})
