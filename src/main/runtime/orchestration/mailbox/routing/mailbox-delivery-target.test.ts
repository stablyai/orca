import { describe, expect, it, vi } from 'vitest'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'

function target(readShell: () => Promise<boolean>) {
  return new OrchestrationMailboxDeliveryTarget({
    getDb: () => null,
    getMailboxTerminalForPaneKey: () => null,
    getTerminalForHandle: () => null,
    hasTerminalHandle: () => true,
    isStructuredSessionOwner: () => false,
    canProbePtyLiveness: () => true,
    controllerKnowsPtyIsLive: () => true,
    isLeafPtyProvenAbsent: async () => false,
    foregroundShellProbe: () => ({ incarnationId: 'inc-1', read: readShell })
  })
}

/** Delivers each batch in its own turn; a re-probe re-enters delivery as production does. */
async function probe(
  readShell: () => Promise<boolean>,
  batches: string[][]
): Promise<[string, boolean][]> {
  vi.useFakeTimers()
  try {
    const delivery = target(readShell)
    const redelivered: [string, boolean][] = []
    const deliver = (mailbox: string): void => {
      delivery.deferForTerminalProbe('pty-1', mailbox, false, (probed, reprobe) => {
        redelivered.push([probed, reprobe])
        if (reprobe) {
          deliver(probed)
        }
      })
    }
    for (const batch of batches) {
      batch.forEach(deliver)
      await Promise.resolve()
    }
    await vi.runAllTimersAsync()
    return redelivered
  } finally {
    vi.useRealTimers()
  }
}

describe('deferForTerminalProbe', () => {
  // An exited agent's status outlives it; typing then runs the pointer in the shell and consumes the mail.
  it('holds every mailbox of a terminal while a shell is in front of the exited agent', async () => {
    expect(await probe(async () => true, [['term_a', 'run:r1']])).toEqual([])
  })

  it('types once the agent itself is in front', async () => {
    expect(await probe(async () => false, [['term_a']])).toEqual([['term_a', false]])
  })

  it.each([true, false])(
    'probes again, once, for a delivery that arrived during the read (shell in front: %s)',
    async (shellInFront) => {
      const reads = [shellInFront, true]
      expect(await probe(async () => reads.shift() ?? true, [['term_a'], ['run:r1']])).toEqual([
        ['term_a', true],
        ['run:r1', true]
      ])
    }
  )

  it('hands a deferred delivery its reserved types back, unrestricted once an unreserved one joins', async () => {
    vi.useFakeTimers()
    try {
      const delivery = target(async () => false)
      const reservedBack: string[][] = []
      const deliver = (mailbox: string, reserved?: ReadonlySet<string>): void => {
        delivery.deferForTerminalProbe(
          'pty-1',
          mailbox,
          false,
          (_mailbox, _reprobe, types) => reservedBack.push([...(types ?? [])]),
          reserved
        )
      }
      deliver('term_a', new Set(['question']))
      deliver('run:r1', new Set(['question']))
      deliver('run:r1')
      await vi.runAllTimersAsync()
      expect(reservedBack).toEqual([['question'], []])
    } finally {
      vi.useRealTimers()
    }
  })
  it('re-reads once per batch of joiners, so a steady stream of deliveries still types', async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const typed: string[] = []
      let delivery: OrchestrationMailboxDeliveryTarget
      const deliver = (mailbox: string): void => {
        delivery.deferForTerminalProbe('pty-1', mailbox, false, (probed, reprobe) =>
          reprobe ? deliver(probed) : typed.push(probed)
        )
      }
      // Every read sees a new delivery join it while it is in flight.
      delivery = target(async () => {
        reads += 1
        await Promise.resolve()
        deliver(`run:r${reads}`)
        return false
      })
      deliver('term_a')
      await vi.runAllTimersAsync()
      expect({ reads, typed }).toEqual({ reads: 2, typed: ['term_a', 'run:r1', 'run:r2'] })
    } finally {
      vi.useRealTimers()
    }
  })
  it('re-reads when the agent returns during a forced read that saw a shell', async () => {
    vi.useFakeTimers()
    try {
      const verdicts = [false, true, false]
      let reads = 0
      const typed: string[] = []
      let delivery: OrchestrationMailboxDeliveryTarget
      const deliver = (mailbox: string): void => {
        delivery.deferForTerminalProbe('pty-1', mailbox, false, (probed, reprobe) =>
          reprobe ? deliver(probed) : typed.push(probed)
        )
      }
      // The first two reads each see a later delivery join: new mail, then the agent's return edge.
      delivery = target(async () => {
        reads += 1
        await Promise.resolve()
        if (reads <= 2) {
          deliver(`run:r${reads}`)
        }
        return verdicts[reads - 1] ?? false
      })
      deliver('term_a')
      await vi.runAllTimersAsync()
      expect({ reads, typed }).toEqual({ reads: 3, typed: ['term_a', 'run:r1', 'run:r2'] })
    } finally {
      vi.useRealTimers()
    }
  })
})
