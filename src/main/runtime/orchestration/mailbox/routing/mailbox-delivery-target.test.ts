import { describe, expect, it, vi } from 'vitest'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'

function target(shellInFront: boolean | null) {
  return new OrchestrationMailboxDeliveryTarget({
    getDb: () => null,
    getMailboxTerminalForPaneKey: () => null,
    getTerminalForHandle: () => null,
    hasTerminalHandle: () => true,
    isStructuredSessionOwner: () => false,
    canProbePtyLiveness: () => true,
    controllerKnowsPtyIsLive: () => true,
    isLeafPtyProvenAbsent: async () => false,
    foregroundShellProbe: () => (shellInFront === null ? null : async () => shellInFront)
  })
}

async function probe(
  shellInFront: boolean | null
): Promise<{ deferred: boolean; redelivered: string[] }> {
  vi.useFakeTimers()
  try {
    const redelivered: string[] = []
    const deferred = target(shellInFront).deferForTerminalProbe(
      'pty-1',
      'term_a',
      false,
      (mailbox) => redelivered.push(mailbox)
    )
    await vi.runAllTimersAsync()
    return { deferred, redelivered }
  } finally {
    vi.useRealTimers()
  }
}

describe('deferForTerminalProbe', () => {
  // An exited agent's status outlives it; typing then runs the pointer in the shell and consumes the mail.
  it('holds mail while a shell is in front of the exited agent', async () => {
    expect(await probe(true)).toEqual({ deferred: true, redelivered: [] })
  })

  it('types once the agent itself is in front', async () => {
    expect(await probe(false)).toEqual({ deferred: true, redelivered: ['term_a'] })
  })
})
