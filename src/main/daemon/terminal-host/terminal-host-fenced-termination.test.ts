import { describe, expect, it } from 'vitest'
import { beginTerminalHostFencedTermination } from './terminal-host-fenced-termination'
import type { Session } from '../sessions/session'
import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/agent-session/lifecycle/leases/claimed-agent-pty-owner'

type KillVerdict = { writersExited: boolean } | void

function terminate(verdict: KillVerdict) {
  const session = { incarnationId: 'inc-a', isAlive: true, hasAttachedClients: false }
  const fields = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fencing reads only these session fields.
    sessions: new Map([['pty-a', session as unknown as Session]]),
    pendingCreations: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fencing only lists owners.
    owners: { listForPty: () => [] } as unknown as ClaimedAgentPtyOwnerRegistry,
    kill: async () => {
      session.isAlive = false
      return verdict
    }
  }
  const started = beginTerminalHostFencedTermination(
    {
      id: 'pty-a',
      expectedIncarnationId: 'inc-a',
      requireNoAgentOwner: true,
      requireUnattached: false
    },
    fields
  )
  if (!started.accepted) {
    throw new Error('expected the stop to be accepted')
  }
  return started.completion
}

describe('fenced termination writer evidence', () => {
  it('reports writers gone only when the teardown proved it', async () => {
    await expect(terminate({ writersExited: true })).resolves.toEqual({
      outcome: 'ended',
      writersExited: true
    })
  })

  it('reports a bare root exit when a descendant was live or unverifiable', async () => {
    await expect(terminate({ writersExited: false })).resolves.toEqual({ outcome: 'ended' })
  })

  it('never claims writer evidence from a kill that reports none', async () => {
    await expect(terminate(undefined)).resolves.toEqual({ outcome: 'ended' })
  })
})
