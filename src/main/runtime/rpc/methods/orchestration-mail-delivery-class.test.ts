import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('orchestration mail delivery class and presence count', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  function setup(): OrchestrationDb {
    const created = new OrchestrationDb(':memory:')
    db = created
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(created)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => undefined)
    runId = created.createRun({
      objective: 'delivery class',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
    return created
  }

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>): Promise<never> {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return (await method.handler(parsed, ctx)) as never
  }

  it('carries the sender delivery class through send and back out of check', async () => {
    setup()

    const sent = (await call('orchestration.send', {
      from: 'term_coord',
      to: `run:${runId}`,
      subject: 'drop everything',
      type: 'escalation',
      deliveryClass: 'interrupt',
      run: runId
    })) as unknown as { message: { delivery_class: string } }
    expect(sent.message.delivery_class).toBe('interrupt')

    const checked = (await call('orchestration.check', {
      terminal: 'term_coord'
    })) as unknown as { messages: { delivery_class: string }[] }
    expect(checked.messages.map((message) => message.delivery_class)).toEqual(['interrupt'])
  })

  it('defaults an existing caller to turn', async () => {
    setup()

    const sent = (await call('orchestration.send', {
      from: 'term_coord',
      to: `run:${runId}`,
      subject: 'read this when you finish',
      run: runId
    })) as unknown as { message: { delivery_class: string } }

    expect(sent.message.delivery_class).toBe('turn')
  })

  it('rejects a delivery class the contract does not define', () => {
    const method = findMethod('orchestration.send')

    expect(() =>
      method.params?.parse({ subject: 'hi', to: 'term_x', deliveryClass: 'immediate' })
    ).toThrow()
  })

  it('answers count with a per-class breakdown and creates no Delivery', async () => {
    setup()
    for (const deliveryClass of ['interrupt', 'turn'] as const) {
      await call('orchestration.send', {
        from: 'term_coord',
        to: `run:${runId}`,
        subject: deliveryClass,
        deliveryClass,
        run: runId
      })
    }

    const counted = (await call('orchestration.check', {
      terminal: 'term_coord',
      count: true,
      peek: true,
      unread: false
    })) as unknown as {
      count: number
      countByDeliveryClass: Record<string, number>
      messages: unknown[]
      deliveryId?: string
    }

    expect(counted.count).toBe(2)
    expect(counted.countByDeliveryClass).toEqual({ interrupt: 1, tool: 0, turn: 1 })
    expect(counted.messages).toEqual([])
    expect(counted.deliveryId).toBeUndefined()
    // The next real check still gets the whole batch: the probe consumed nothing.
    const checked = (await call('orchestration.check', {
      terminal: 'term_coord'
    })) as unknown as { messages: unknown[] }
    expect(checked.messages).toHaveLength(2)
  })

  it('refuses to fold a presence probe into an acknowledgment or a wait', () => {
    const method = findMethod('orchestration.check')

    expect(() =>
      method.params?.parse({ terminal: 'term_coord', count: true, wait: true })
    ).toThrow()
    expect(() =>
      method.params?.parse({ terminal: 'term_coord', count: true, ack: 'delivery_1' })
    ).toThrow()
    expect(() => method.params?.parse({ terminal: 'term_coord', count: true, all: true })).toThrow()
  })
})
