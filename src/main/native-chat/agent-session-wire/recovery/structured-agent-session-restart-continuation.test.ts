import { expect, it, vi } from 'vitest'
import {
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationDeps
} from './structured-agent-session-restart-continuation'

function deps(
  dispatched: { dispatchState: string } | undefined
): StructuredAgentSessionContinuationDeps {
  return {
    currentFence: () => 1,
    send: async () => ({ ok: true, value: { submission: { dispatchState: 'pending' } } }),
    awaitHandedOver: async () => ({ dispatchState: 'pending' }),
    // The turn running at handover ended without taking the send.
    awaitSettlement: async () => ({ dispatchState: 'unknown' }),
    awaitDispatched: async () => dispatched,
    note: vi.fn(async () => {}),
    liftRestartHold: vi.fn(async () => {}),
    logger: { warn: vi.fn(), error: vi.fn() }
  }
}

async function verdictWith(dispatched: { dispatchState: string } | undefined) {
  const started = await startStructuredAgentSessionContinuation(
    deps(dispatched),
    'session-1',
    {},
    'continuation-1'
  )
  if (!('verdict' in started)) {
    throw new Error('expected a pending verdict')
  }
  return (await started.verdict()).outcome
}

it('counts a continuation the next turn accepts after the handover turn ended', async () => {
  expect(await verdictWith({ dispatchState: 'accepted' })).toBe('continued')
})

it('stays unconfirmed when the provider never answers', async () => {
  expect(await verdictWith(undefined)).toBe('unknown')
})
