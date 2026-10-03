import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { AgentHookServer } from '../agent-hooks/server'
import { PANE } from '../agent-hooks/server.test-fixtures'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import {
  createAntigravityChatInterruptHost,
  type AntigravityInterruptBinding
} from './antigravity-chat-interrupt-host'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())

function harness() {
  const server = new AgentHookServer()
  const submit = () =>
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'conversation_id', id: 'test-conversation' },
        payload: { state: 'working', agentType: 'antigravity', prompt: 'bounded task' }
      },
      'host'
    )
  submit()
  const row = server.getStatusSnapshot()[0]
  if (!row.observation) {
    throw new Error('Missing canonical observation')
  }
  const request = {
    terminal: 'term',
    providerSessionId: 'test-conversation',
    observation: {
      authorityId: row.observation.authorityId,
      incarnation: row.observation.incarnation,
      revision: row.observation.revision
    }
  }
  let generation = 1
  let bound = true
  let supported = true
  const delivery = Promise.withResolvers<WriteSettlement>()
  const write = vi.fn(() => delivery.promise)
  const infer = vi.fn((input: Parameters<AgentHookServer['inferInterrupt']>[0]) =>
    server.inferInterrupt(input)
  )
  const cancel = createAntigravityChatInterruptHost({
    supported: () => supported,
    readBinding: (): AntigravityInterruptBinding | null =>
      bound
        ? {
            ptyId: 'pty',
            generation,
            row: server.getStatusSnapshot()[0]
          }
        : null,
    write,
    infer
  })
  return {
    server,
    request,
    delivery,
    cancel,
    write,
    infer,
    submit,
    rebind: () => {
      generation += 1
    },
    unbind: () => {
      bound = false
    },
    unsupported: () => {
      supported = false
    }
  }
}

it('settles exactly one accepted Escape through the canonical hook server after its delay', async () => {
  const h = harness()
  const listener = vi.fn()
  h.server.setListener(listener)
  listener.mockClear()
  const first = h.cancel(h.request)
  const duplicate = h.cancel(h.request)
  expect(duplicate).toBe(first)
  h.delivery.resolve(WRITE_ACCEPTED)
  await vi.advanceTimersByTimeAsync(499)
  expect(h.infer).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await first).toEqual({ accepted: true, inferred: true })
  expect(h.write).toHaveBeenCalledTimes(1)
  expect(h.infer).toHaveBeenCalledTimes(1)
  expect(h.server.getStatusSnapshot()[0]).toMatchObject({
    state: 'done',
    interrupted: true,
    providerSession: { id: 'test-conversation' },
    observation: { revision: h.request.observation.revision + 1 }
  })
  expect(await h.cancel(h.request)).toMatchObject({
    accepted: false,
    inferred: false,
    reason: 'stale'
  })
  expect(listener).toHaveBeenCalledTimes(1)
})

it.each([
  writeRefused('provider_refused_write'),
  writeUnverifiable('transport_settlement_lost', true)
])('does not infer from $outcome input', async (settlement) => {
  const h = harness()
  const operation = h.cancel(h.request)
  h.delivery.resolve(settlement)
  expect(await operation).toMatchObject({
    accepted: false,
    inferred: false,
    reason: settlement.outcome
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.infer).not.toHaveBeenCalled()
  expect(h.server.getStatusSnapshot()[0].state).toBe('working')
})

it.each(['new turn', 'rebind', 'unbind'] as const)(
  'does not interrupt a replacement after %s',
  async (change) => {
    const h = harness()
    const operation = h.cancel(h.request)
    h.delivery.resolve(WRITE_ACCEPTED)
    await vi.advanceTimersByTimeAsync(200)
    if (change === 'new turn') {
      h.submit()
    }
    if (change === 'rebind') {
      h.rebind()
    }
    if (change === 'unbind') {
      h.unbind()
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(await operation).toEqual({ accepted: true, inferred: false, reason: 'stale' })
    expect(h.infer).not.toHaveBeenCalled()
  }
)

it.each(['authorityId', 'incarnation', 'revision', 'provider', 'stale', 'unsupported'] as const)(
  'refuses %s before any input',
  async (change) => {
    const h = harness()
    const request = structuredClone(h.request)
    if (change === 'authorityId') {
      request.observation.authorityId = 'different-host'
    }
    if (change === 'incarnation') {
      request.observation.incarnation += 1
    }
    if (change === 'revision') {
      request.observation.revision += 1
    }
    if (change === 'provider') {
      request.providerSessionId = 'different-conversation'
    }
    if (change === 'stale') {
      vi.setSystemTime(10_001 + AGENT_STATUS_STALE_AFTER_MS)
    }
    if (change === 'unsupported') {
      h.unsupported()
    }
    expect(await h.cancel(request)).toMatchObject({ accepted: false, inferred: false })
    expect(h.write).not.toHaveBeenCalled()
  }
)
