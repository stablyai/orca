import { describe, expect, it } from 'vitest'
import { SshPtyLegacyProjectionLedger } from './ssh-pty-legacy-projection'
import { SshPtyProjectionTerminality } from './ssh-pty-projection-terminality'

function reserve(
  ledger: SshPtyLegacyProjectionLedger,
  overrides: Partial<Parameters<SshPtyLegacyProjectionLedger['reserve']>[0]> = {}
) {
  return ledger.reserve({
    ptyId: 'pty-1',
    providerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    data: 'abc',
    sequenceEnd: 3,
    rawLength: 3,
    transformed: false,
    ...overrides
  })
}

function source(sourceStartSu: number, sourceEndSu: number, deliveryToken = 'token-1') {
  return {
    spanId: `span-${sourceStartSu}`,
    clientGeneration: 2,
    ownerGeneration: 4,
    deliveryToken,
    sourceStartSu,
    sourceEndSu
  }
}

describe('SshPtyLegacyProjectionLedger', () => {
  it('drains exact terminality waiters when their provider generation closes', async () => {
    const terminality = new SshPtyProjectionTerminality()
    const terminal = terminality.whenTerminal('pty-1', 3, 'incarnation-1', () => true)
    let nextResolved = false
    const next = terminality
      .whenTerminal('pty-1', 4, 'incarnation-2', () => true)
      .then(() => {
        nextResolved = true
      })

    terminality.closeGeneration(3)

    await expect(terminal).resolves.toBeUndefined()
    expect(nextResolved).toBe(false)
    terminality.closeGeneration(4)
    await next
  })

  it('rolls back scanner and display reservations before commit', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    const partial = reserve(ledger, { data: '\x1b[?20', rawLength: 5, sequenceEnd: 5 })
    expect(ledger.rollback(partial)).toBe(true)

    const next = reserve(ledger, { data: '31h', sequenceEnd: 3 })
    expect(next.semantics.identity.displayStart).toBe(0)
    expect(next.semantics.beforeScanner).toEqual({ tail: '', pendingSubscribe: false })
    expect(next.semantics.decision).toBeNull()
  })

  it('keeps immutable generation, incarnation, display, sequence, raw length, and scanner facts', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    const first = reserve(ledger, {
      data: '\x1b[?2031h',
      rawLength: 11,
      sequenceEnd: 11
    })
    const semantics = ledger.commit(first)

    expect(semantics.identity).toMatchObject({
      providerGeneration: 3,
      ptyIncarnation: 'incarnation-1',
      displayStart: 0,
      displayEnd: 8,
      sequenceEnd: 11,
      rawLength: 11
    })
    expect(semantics.decision).toBe('subscribed')
    expect(Object.isFrozen(semantics)).toBe(true)
    expect(Object.isFrozen(semantics.identity)).toBe(true)
  })

  it('rejects stale generations and resets cross-chunk scanner state on gaps', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    ledger.commit(reserve(ledger, { data: '\x1b[?20', rawLength: 5, sequenceEnd: 5 }))
    ledger.resetForGap('pty-1')
    const next = reserve(ledger, { data: '31h', sequenceEnd: 8 })
    expect(next.semantics.beforeScanner).toEqual({ tail: '', pendingSubscribe: false })

    expect(() => reserve(ledger, { providerGeneration: 2 })).toThrow(
      'ssh_projection_stale_generation'
    )
  })

  it('publishes, settles, and transfers explicit ranges', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    const first = ledger.commit(reserve(ledger))
    ledger.publishPrefix([first.identity.projectionSemanticsId], 3, 3)
    expect(ledger.settlePublishedPrefix('pty-1', 2)).toBe(2)
    expect(ledger.transfer([first.identity.projectionSemanticsId], 'renderer-reload')).toBe(1)
    expect(ledger.getDebugSnapshot()).toMatchObject({ transferred: 1, records: 0 })
  })

  it('resolves exact PTY terminal waiters only after settlement or transfer', async () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    const projection = ledger.commit(reserve(ledger))
    ledger.publishPrefix([projection.identity.projectionSemanticsId], 3, 3)

    let settled = false
    const terminal = ledger.whenPtyTerminal('pty-1', 3, 'incarnation-1').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ledger.settlePublishedPrefix('pty-1', 2)
    await Promise.resolve()
    expect(settled).toBe(false)
    ledger.transfer([projection.identity.projectionSemanticsId], 'renderer-reload')
    await terminal
    expect(settled).toBe(true)
  })

  it('publishes and settles transformed source accounting with no display text', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    const projection = ledger.commit(
      reserve(ledger, {
        data: '',
        sequenceEnd: 9,
        rawLength: 9,
        transformed: true
      })
    )

    ledger.publishPrefix([projection.identity.projectionSemanticsId], 0, 9)
    expect(ledger.settlePublishedPrefix('pty-1', 9)).toBe(9)
    expect(ledger.getDebugSnapshot()).toMatchObject({ settled: 1, records: 0 })
  })

  it('reclaims a closed PTY cursor so its id can be reused by a new incarnation', () => {
    const ledger = new SshPtyLegacyProjectionLedger()
    ledger.commit(reserve(ledger))
    ledger.closePty('pty-1', 3, 'incarnation-1', 'pty-exit')

    const next = reserve(ledger, {
      ptyIncarnation: 'incarnation-2',
      data: 'next',
      sequenceEnd: 4,
      rawLength: 4
    })
    expect(next.semantics.identity).toMatchObject({
      ptyIncarnation: 'incarnation-2',
      displayStart: 0
    })
    expect(ledger.getDebugSnapshot()).toMatchObject({ records: 1, cursors: 1 })
  })

  it('keeps split publication attached to one immutable desktop span', () => {
    const settled: unknown[] = []
    const ledger = new SshPtyLegacyProjectionLedger({
      onSettled: (span) => settled.push(span)
    })
    const projection = ledger.commit(
      reserve(ledger, {
        data: 'abcd',
        rawLength: 4,
        sequenceEnd: 4,
        source: source(0, 4)
      })
    )
    const id = projection.identity.projectionSemanticsId
    expect(ledger.hasUnpublished(id)).toBe(true)

    ledger.publishPrefix([id], 2, 2)
    expect(ledger.hasUnpublished(id)).toBe(true)
    ledger.settlePublishedPrefix('pty-1', 2)
    expect(settled).toEqual([])
    ledger.publishPrefix([id], 2, 2)
    expect(ledger.hasUnpublished(id)).toBe(false)
    ledger.settlePublishedPrefix('pty-1', 2)

    expect(settled).toEqual([
      expect.objectContaining({
        spanId: 'span-0',
        projectionSemanticsId: id,
        sourceStartSu: 0,
        sourceEndSu: 4,
        displayStart: 0,
        displayEnd: 4
      })
    ])
  })

  it('preserves scanner and display facts after transfer and delivery-token replacement', () => {
    const transferred: unknown[] = []
    const ledger = new SshPtyLegacyProjectionLedger({
      onTransferred: (span) => transferred.push(span)
    })
    const partial = ledger.commit(
      reserve(ledger, {
        data: '\x1b[?20',
        rawLength: 5,
        sequenceEnd: 5,
        source: source(0, 5)
      })
    )
    ledger.transfer([partial.identity.projectionSemanticsId], 'renderer-reload')
    const continuation = reserve(ledger, {
      data: '31h',
      rawLength: 3,
      sequenceEnd: 8,
      source: source(5, 8, 'token-2')
    })

    expect(continuation.semantics.identity.displayStart).toBe(5)
    expect(continuation.semantics.beforeScanner.tail).toBe('\x1b[?20')
    expect(continuation.semantics.decision).toBe('subscribed')
    expect(transferred).toEqual([
      expect.objectContaining({
        deliveryToken: 'token-1',
        sourceStartSu: 0,
        sourceEndSu: 5
      })
    ])
  })

  it('leaves a projection intact when its terminal transition cannot commit', () => {
    const ledger = new SshPtyLegacyProjectionLedger({
      onTransferred: () => {
        throw new Error('replacement unavailable')
      }
    })
    const projection = ledger.commit(reserve(ledger, { source: source(0, 3) }))

    expect(() =>
      ledger.transfer([projection.identity.projectionSemanticsId], 'renderer-reload')
    ).toThrow('replacement unavailable')
    expect(ledger.getDebugSnapshot()).toMatchObject({
      transferred: 0,
      records: 1
    })
  })
})
