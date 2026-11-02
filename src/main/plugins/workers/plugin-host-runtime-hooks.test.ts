import { describe, expect, it, vi } from 'vitest'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

async function activated(activate: (orca: PluginWorkerOrcaApi) => void) {
  const send = vi.fn()
  const runtime = createPluginWorkerRuntime({
    send,
    exit: vi.fn(),
    importModule: async () => ({ default: activate })
  })
  await runtime.handleMessage({
    orca: 1,
    kind: 'evt',
    event: 'init',
    payload: {
      pluginId: 'samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    }
  })
  const request = async (id: number, params: unknown) => {
    await runtime.handleMessage({ orca: 1, kind: 'req', id, method: 'hook.run', params })
    return send.mock.calls.map(([message]) => message).find((message) => message.id === id)
  }
  return { request }
}

const event = { terminalId: 't', text: 'rm -rf /', enter: true, inputKind: 'driving' }

describe('worker hook.run', () => {
  it('answers with the decision of the handlers registered for the hook', async () => {
    const { request } = await activated((orca) => {
      orca.hooks.on('terminal.send', () => ({ deny: 'blocked' }))
    })
    expect(await request(1, { event: 'terminal.send', payload: event })).toMatchObject({
      kind: 'res',
      result: { decision: 'result', result: { deny: 'blocked' } }
    })
  })

  it('passes when no handler is registered or after dispose', async () => {
    const { request } = await activated((orca) => {
      orca.hooks.on('terminal.send', () => ({ deny: 'blocked' })).dispose()
    })
    expect(await request(2, { event: 'terminal.send', payload: event })).toMatchObject({
      result: { decision: 'continue', payload: event }
    })
  })

  it('reports a throwing handler as a failure the host treats as passing', async () => {
    const { request } = await activated((orca) => {
      orca.hooks.on('terminal.send', () => {
        throw new Error('boom')
      })
    })
    expect(await request(3, { event: 'terminal.send', payload: event })).toMatchObject({
      error: { code: 'action_failed' }
    })
  })

  it('refuses an unknown hook at registration', async () => {
    let failure: unknown
    await activated((orca) => {
      try {
        // @ts-expect-error not a hook
        orca.hooks.on('terminal.write', () => undefined)
      } catch (error) {
        failure = error
      }
    })
    expect(String(failure)).toMatch(/unknown hook terminal\.write/)
  })
})
