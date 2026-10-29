import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../runtime/orchestration/types'
import type { MessageWaitResult } from '../runtime/runtime-message-waiters'
import {
  VoiceControlReplyPump,
  type ControlMailboxMessage,
  type VoiceControlReplyPumpDeps
} from './voice-control-reply-pump'

function row(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'm1',
    run_id: 'run-1',
    from_handle: 'term_abc',
    to_handle: 'run:run-1',
    subject: 'worker_done',
    body: 'tests are green',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-10-07T00:00:00Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

function createDeps(overrides: Partial<VoiceControlReplyPumpDeps> = {}) {
  const delivered: ControlMailboxMessage[][] = []
  const acked: string[] = []
  const deps: VoiceControlReplyPumpDeps = {
    waitForMessage: () => new Promise<MessageWaitResult>(() => {}),
    getRunConsumerGeneration: () => 7,
    getRunDelivery: () => undefined,
    acknowledgeRunDelivery: ({ deliveryId }) => acked.push(deliveryId),
    onMessages: (messages) => delivered.push(messages),
    ...overrides
  }
  return { deps, delivered, acked }
}

describe('VoiceControlReplyPump', () => {
  it('waits on the run mailbox with the wake types and exclusive flag', async () => {
    const seen: { handle?: string; options?: { exclusive?: boolean; typeFilter?: string[] } } = {}
    const { deps } = createDeps({
      waitForMessage: (handle, options) => {
        seen.handle = handle
        seen.options = options
        return new Promise<MessageWaitResult>(() => {})
      }
    })
    const pump = new VoiceControlReplyPump(deps, 'run-1')
    pump.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen.handle).toBe('run:run-1')
    expect(seen.options?.exclusive).toBe(true)
    expect(seen.options?.typeFilter).toContain('worker_done')
    pump.stop()
  })

  it('drains, projects, acks, and emits — including pane and dispatch correlation', () => {
    const { deps, delivered, acked } = createDeps({
      getRunDelivery: () => ({
        delivery: { id: 'delivery-9' },
        messages: [row({ payload: '{"dispatchId":"dispatch-1"}', sender_pane_key: 'tab-1:leaf' })]
      })
    })
    const pump = new VoiceControlReplyPump(deps, 'run-1')
    pump.drain()
    expect(acked).toEqual(['delivery-9'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.[0]).toMatchObject({
      body: 'tests are green',
      senderPaneKey: 'tab-1:leaf',
      dispatchId: 'dispatch-1'
    })
  })

  it('acks even an empty batch without emitting', () => {
    const { deps, delivered, acked } = createDeps({
      getRunDelivery: () => ({ delivery: { id: 'delivery-1' }, messages: [] })
    })
    new VoiceControlReplyPump(deps, 'run-1').drain()
    expect(acked).toEqual(['delivery-1'])
    expect(delivered).toHaveLength(0)
  })

  it('drops empty-body messages but keeps real ones', () => {
    const { deps, delivered } = createDeps({
      getRunDelivery: () => ({
        delivery: { id: 'delivery-2' },
        messages: [row({ id: 'm-empty', body: '' }), row({ id: 'm-real', body: 'done' })]
      })
    })
    new VoiceControlReplyPump(deps, 'run-1').drain()
    expect(delivered[0]?.map((m) => m.id)).toEqual(['m-real'])
  })

  it('tolerates a vanished run and malformed payloads', () => {
    const { deps, delivered } = createDeps({
      getRunConsumerGeneration: () => null,
      getRunDelivery: () => ({
        delivery: { id: 'd3' },
        messages: [row({ payload: 'not json' })]
      })
    })
    const pump = new VoiceControlReplyPump(deps, 'run-1')
    pump.drain() // generation null → no-op, no throw
    expect(delivered).toHaveLength(0)
  })

  it('stop aborts the wait loop', async () => {
    let signal: AbortSignal | undefined
    const { deps } = createDeps({
      waitForMessage: (_handle, options) => {
        signal = options.signal
        return new Promise<MessageWaitResult>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
    })
    const pump = new VoiceControlReplyPump(deps, 'run-1')
    pump.start()
    pump.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signal?.aborted).toBe(true)
  })
})
