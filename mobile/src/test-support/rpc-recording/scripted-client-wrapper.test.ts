import { describe, expect, it } from 'vitest'
import { ScriptedRpcTransport } from './scripted-rpc-transport'

// Require one physical send per logical name in call order; dropped sends must fail before mislabelling later payloads.
describe('a wrapper between the operation and the scripted transport', () => {
  it('is caught when it swallows a send, rather than mislabelling the next payload', () => {
    const transport = new ScriptedRpcTransport(
      () => 0,
      undefined,
      (client) => ({
        ...client,
        sendRequest: (...args) =>
          args[0] === 'alpha.one'
            ? Promise.reject(new Error('the wrapper kept this one'))
            : client.sendRequest(...args)
      })
    )
    void transport.client.sendRequest('alpha.one').catch(() => undefined)
    expect(() => transport.client.sendRequest('beta.two')).toThrow(/beta\.two.*alpha\.one#1/)
  })

  it('is caught when it invents a send the operation never made', () => {
    let inner: ((method: string) => Promise<unknown>) | null = null
    new ScriptedRpcTransport(
      () => 0,
      undefined,
      (client) => {
        inner = (method) => client.sendRequest(method)
        return client
      }
    )
    expect(inner).not.toBeNull()
    expect(() => inner?.('alpha.one')).toThrow(/cannot take the name \(no logical request\)/)
  })

  it('names each physical send after the logical call that made it', async () => {
    const transport = new ScriptedRpcTransport()
    void transport.client.sendRequest('alpha.one')
    void transport.client.sendRequest('beta.two')
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.payloads.map((payload) => payload.name)).toEqual(['alpha.one#1', 'beta.two#1'])
  })
})
