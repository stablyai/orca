// A wait on a child's start follows that child, not the object the host keeps for it: a re-attach
// rebuilds the same child, and only a different child ends the wait.

import { describe, expect, it } from 'vitest'
import {
  indexProviderChild,
  markProviderChildStarted,
  providerChildStartSettled
} from './structured-agent-session-provider-child'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

function bearer(child: StructuredAgentSessionProviderChild) {
  return { child, journal: { cursor: () => ({ epoch: 'e1', sequence: 0 }) } }
}

const starting = (generation: string): StructuredAgentSessionProviderChild => ({
  generation,
  fence: 1,
  phase: 'starting'
})

describe('a start wait across a re-index of the child', () => {
  it('stays with the same child rebuilt by a re-attach, and settles ready once it starts', async () => {
    const session = bearer(starting('gen-1'))
    const wait = providerChildStartSettled(session)
    const rebuilt = starting('gen-1')

    indexProviderChild(session, rebuilt)
    markProviderChildStarted(session, rebuilt)

    expect(await wait).toBe('ready')
  })

  it('settles ready when the rebuilt child has already proven its start', async () => {
    const session = bearer(starting('gen-1'))
    const wait = providerChildStartSettled(session)

    indexProviderChild(session, { ...starting('gen-1'), phase: 'ready' })

    expect(await wait).toBe('ready')
  })

  it('settles ended when a different child replaces the one waited on', async () => {
    const session = bearer(starting('gen-1'))
    const wait = providerChildStartSettled(session)

    indexProviderChild(session, starting('gen-2'))

    expect(await wait).toBe('ended')
  })
})
