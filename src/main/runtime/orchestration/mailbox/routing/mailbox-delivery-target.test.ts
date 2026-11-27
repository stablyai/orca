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

async function probe(
  readShell: () => Promise<boolean>,
  mailboxes: string[]
): Promise<[string, boolean][]> {
  vi.useFakeTimers()
  try {
    const delivery = target(readShell)
    const redelivered: [string, boolean][] = []
    for (const mailbox of mailboxes) {
      expect(
        delivery.deferForTerminalProbe('pty-1', mailbox, false, (probed, reprobe) =>
          redelivered.push([probed, reprobe])
        )
      ).toBe(true)
    }
    await vi.runAllTimersAsync()
    return redelivered
  } finally {
    vi.useRealTimers()
  }
}

describe('deferForTerminalProbe', () => {
  // An exited agent's status outlives it; typing then runs the pointer in the shell and consumes the mail.
  it('holds mail while a shell is in front of the exited agent', async () => {
    expect(await probe(async () => true, ['term_a'])).toEqual([])
  })

  it('types once the agent itself is in front', async () => {
    expect(await probe(async () => false, ['term_a'])).toEqual([['term_a', false]])
  })

  it('probes again when a delivery joined a probe that then read a shell', async () => {
    expect(await probe(async () => true, ['term_a', 'run:r1'])).toEqual([
      ['term_a', true],
      ['run:r1', true]
    ])
  })
})
