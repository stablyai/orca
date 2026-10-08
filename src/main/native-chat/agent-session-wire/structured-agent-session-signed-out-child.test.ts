// A child that reported it is not signed in is replaced before the next send, so a sign-in made
// since reaches a new child; an agent that read its login once at start would fail again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  acceptedDispatch,
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { structuredAgentSessionChildReportedSignedOut } from './structured-agent-session-signed-out-child'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'

describe('a send after the agent said it is not signed in', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  it('goes to a new agent, and the new agent is kept for the sends after it', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('signed out', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    rig.adapter.closeSession.mockClear()

    expect((await rig.host.send(CALLER, restTestSend('signed in now', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)

    // The earlier child's report does not follow the new one.
    expect((await rig.host.send(CALLER, restTestSend('and again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps the agent after any other rejection', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('refused', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    rig.adapter.dispatch.mockImplementation(async () => acceptedDispatch())

    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
  })
})

describe('structuredAgentSessionChildReportedSignedOut', () => {
  const child = (
    overrides: Partial<StructuredAgentSessionProviderChild> = {}
  ): StructuredAgentSessionProviderChild => ({
    generation: 'generation-2',
    fence: 2,
    phase: 'ready',
    ...overrides
  })
  const statusRow = (fence: number, kind: 'notSignedIn' | 'providerExited') => ({
    itemId: `status-${fence}-${kind}`,
    fence,
    body: {
      kind: 'status' as const,
      ...agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'row' })
    }
  })
  const rejected = (fence: number) => ({
    fence,
    dispatchState: 'rejected' as const,
    rejection: agentSessionFailureFact('notSignedIn')
  })
  const reported = (
    input: {
      child?: StructuredAgentSessionProviderChild | null
      items?: ReturnType<typeof statusRow>[]
      submissions?: ReturnType<typeof rejected>[]
    } = {}
  ) => {
    const items = input.items ?? []
    return structuredAgentSessionChildReportedSignedOut({
      child: input.child === undefined ? child() : input.child,
      journal: {
        submissions: () => input.submissions ?? [],
        visitItems: (visit) => items.forEach((item, index) => visit(item.itemId, index, item.body)),
        itemFence: (itemId) => items.find((item) => item.itemId === itemId)?.fence,
        activeTurnId: () => null
      }
    })
  }

  it('reads a not-signed-in row the running child wrote', () => {
    expect(reported({ items: [statusRow(2, 'notSignedIn')] })).toBe(true)
  })

  it('ignores one an earlier child wrote, and any other failure', () => {
    expect(reported({ items: [statusRow(1, 'notSignedIn')] })).toBe(false)
    expect(reported({ items: [statusRow(2, 'providerExited')] })).toBe(false)
  })

  it('reads a send rejected as not signed in at this child, not at an earlier one', () => {
    expect(reported({ submissions: [rejected(2)] })).toBe(true)
    expect(reported({ submissions: [rejected(1)] })).toBe(false)
  })

  it('leaves a child that is starting, closing, or absent', () => {
    const items = [statusRow(2, 'notSignedIn')]
    expect(reported({ items, child: child({ phase: 'starting' }) })).toBe(false)
    expect(reported({ items, child: null })).toBe(false)
  })
})
