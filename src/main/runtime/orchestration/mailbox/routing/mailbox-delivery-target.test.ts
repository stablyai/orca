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

  it('probes again, once, for a delivery that arrived while a shell was being read', async () => {
    expect(await probe(async () => true, [['term_a'], ['run:r1']])).toEqual([
      ['term_a', true],
      ['run:r1', true]
    ])
  })

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
})
