import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const callMock = vi.fn()
vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
  }
  class RuntimeClientError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  class RuntimeRpcFailureError extends RuntimeClientError {}
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})
import { main } from './index'

beforeEach(() => {
  callMock.mockReset().mockResolvedValue({ id: 'request', ok: true, result: { messages: [] } })
  vi.stubEnv('ORCA_PANE_KEY', 'own-pane')
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'own-launch')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  process.exitCode = 0
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe('canvas CLI', () => {
  it('discovers teammates using inherited identity', async () => {
    await main(['canvas', 'peers', '--json'])
    expect(callMock).toHaveBeenCalledWith('canvas.peers', {
      paneKey: 'own-pane',
      launchToken: 'own-launch'
    })
  })
  it('sends and replies with an explicit idempotency key', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    await main([
      'canvas',
      'send',
      '--canvas',
      'canvas',
      '--to',
      'peer',
      '--body',
      'The contract',
      '--kind',
      'info',
      '--reply-to',
      'original',
      '--request-id',
      requestId,
      '--json'
    ])
    expect(callMock).toHaveBeenCalledWith('canvas.send', {
      paneKey: 'own-pane',
      launchToken: 'own-launch',
      canvasId: 'canvas',
      to: 'peer',
      body: 'The contract',
      kind: 'info',
      replyTo: 'original',
      requestId
    })
  })
  it('receives only the current canvas inbox', async () => {
    await main(['canvas', 'inbox', '--canvas', 'canvas', '--json'])
    expect(callMock).toHaveBeenCalledWith('canvas.inbox', {
      paneKey: 'own-pane',
      launchToken: 'own-launch',
      canvasId: 'canvas'
    })
  })
  it('refuses calls outside a managed agent terminal', async () => {
    vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', '')
    await main(['canvas', 'peers', '--json'])
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('managed hooks'))
    expect(callMock).not.toHaveBeenCalled()
  })
})
