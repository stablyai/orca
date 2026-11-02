import { describe, expect, it } from 'vitest'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

describe('a transparent wrapper between the operation and the scripted transport', () => {
  it('keeps the sibling identity and still rejects a swallowed invocation', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed, undefined, (client) => ({
      ...client,
      sendRequest: (...args) =>
        args[0] === 'alpha.one'
          ? Promise.reject(new Error('the wrapper kept this one'))
          : client.sendRequest(...args)
    }))
    try {
      const swallowed = transport.client.sendRequest('alpha.one').catch(() => undefined)
      const sibling = transport.client.sendRequest('beta.two')
      await clock.flush()
      expect(transport.payloads.map(({ name }) => name)).toEqual(['beta.two#1'])
      transport.complete('beta.two#1', undefined, { ok: true, result: 'B' })
      await Promise.all([swallowed, sibling])
      await transport.dispose()
      await clock.flush()
      expect(() => transport.causality.assertTransparentCalls()).toThrow('swallowed alpha.one#1')
    } finally {
      await transport.dispose()
      await clock.flush()
      transport.causality.close()
      clock.stop()
    }
  })

  it('rejects an invented call before allocation', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    let invented: (() => Promise<unknown>) | undefined
    const transport = new ScriptedRpcTransport(clock.elapsed, undefined, (client) => {
      invented = () => client.sendRequest('alpha.one')
      return client
    })
    try {
      expect(() => invented?.()).toThrow('no causal parent')
      expect(transport.requests).toEqual([])
      expect(transport.payloads).toEqual([])
      expect(() => transport.check()).toThrow('no causal parent')
    } finally {
      await transport.dispose()
      await clock.flush()
      transport.causality.close()
      clock.stop()
    }
  })
})
