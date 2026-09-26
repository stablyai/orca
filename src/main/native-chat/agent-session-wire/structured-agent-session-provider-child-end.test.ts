import { describe, expect, it } from 'vitest'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  endProviderChild,
  indexProviderChild,
  providerChildEnded
} from './structured-agent-session-provider-child'

const CHILD = { generation: 'generation-1', fence: 1 }

function conversation(): Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> & {
  journal: { cursor: () => { epoch: string; sequence: number } }
} {
  return { child: null, journal: { cursor: () => ({ epoch: 'epoch', sequence: 1 }) } }
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

describe('providerChildEnded', () => {
  it('resolves when the child ends, and at once for one already gone', async () => {
    const session = conversation()
    indexProviderChild(session, { ...CHILD, phase: 'ready' })
    const ended = providerChildEnded(session, CHILD)
    expect(await settled(ended)).toBe(false)

    endProviderChild(session, {
      ...CHILD,
      cause: 'exit',
      reason: null,
      duringStartup: false,
      rootGone: true
    })

    expect(await settled(ended)).toBe(true)
    expect(await settled(providerChildEnded(session, CHILD))).toBe(true)
  })

  it('keeps waiting through a re-attach to the same child, and ends when another replaces it', async () => {
    const session = conversation()
    indexProviderChild(session, { ...CHILD, phase: 'ready' })
    const ended = providerChildEnded(session, CHILD)

    indexProviderChild(session, { ...CHILD, phase: 'ready' })
    expect(await settled(ended)).toBe(false)

    indexProviderChild(session, { generation: 'generation-2', fence: 2, phase: 'ready' })
    expect(await settled(ended)).toBe(true)
  })
})
