import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import { connect, createMockWebContents, sendAndReceive } from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))

describe('background CDP script painting', () => {
  const mock = createMockWebContents()
  const releases: ReturnType<typeof vi.fn>[] = []
  const holdPaint = vi.fn(() => {
    const release = vi.fn()
    releases.push(release)
    return release
  })
  let proxy: CdpWsProxy
  let endpoint: string
  let client: WebSocket

  beforeEach(async () => {
    releases.length = 0
    holdPaint.mockClear()
    mock.webContents.debugger.sendCommand.mockReset().mockResolvedValue({})
    mock.webContents.focus.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every WebContents member this proxy uses.
    proxy = new CdpWsProxy(mock.webContents as never, holdPaint)
    endpoint = await proxy.start()
    client = await connect(endpoint)
  })

  afterEach(async () => {
    client.close()
    await proxy.stop()
    expect(mock.webContents.focus).not.toHaveBeenCalled()
  })

  it.each(['Runtime.evaluate', 'Runtime.callFunctionOn'])(
    'keeps %s paintable until it settles',
    async (method) => {
      let finish: (value: Record<string, unknown>) => void = () => {}
      mock.webContents.debugger.sendCommand.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const response = sendAndReceive(client, { id: 1, method, params: { awaitPromise: true } })
      await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(1))
      expect(releases[0]).not.toHaveBeenCalled()
      finish({ result: { value: 'frame' } })
      expect(await response).toMatchObject({ id: 1, result: { result: { value: 'frame' } } })
      await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledTimes(1))
    }
  )

  it.each(['reject', 'throw'])('releases on a debugger %s', async (failure) => {
    mock.webContents.debugger.sendCommand.mockImplementationOnce(() => {
      if (failure === 'throw') {
        throw new Error('failed')
      }
      return Promise.reject(new Error('failed'))
    })
    expect(await sendAndReceive(client, { id: 2, method: 'Runtime.evaluate' })).toMatchObject({
      error: { message: 'failed' }
    })
    expect(holdPaint).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledTimes(1))
  })

  it('does not hold paint for non-script protocol reads', async () => {
    await sendAndReceive(client, { id: 3, method: 'DOM.getDocument' })
    expect(holdPaint).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'replace', 'stop', 'detach'])(
    'releases a pending script on %s',
    async (end) => {
      let finish: (value: Record<string, unknown>) => void = () => {}
      mock.webContents.debugger.sendCommand.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      client.send(
        JSON.stringify({ id: 4, method: 'Runtime.evaluate', params: { awaitPromise: true } })
      )
      await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(1))
      if (end === 'disconnect') {
        client.close()
      } else if (end === 'replace') {
        client = await connect(endpoint)
      } else if (end === 'stop') {
        await proxy.stop()
      } else {
        mock.emit('detach', {}, 'target_closed')
      }
      await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledTimes(1))
      finish({})
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(releases[0]).toHaveBeenCalledTimes(1)
    }
  )

  it('does not release a replacement client hold when an old script finishes', async () => {
    const finishers: ((value: Record<string, unknown>) => void)[] = []
    mock.webContents.debugger.sendCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishers.push(resolve)
        })
    )
    client.send(JSON.stringify({ id: 5, method: 'Runtime.evaluate' }))
    await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(1))
    client = await connect(endpoint)
    client.send(JSON.stringify({ id: 6, method: 'Runtime.evaluate' }))
    await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(2))
    finishers[0]({})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases[1]).not.toHaveBeenCalled()
    finishers[1]({})
    await vi.waitFor(() => expect(releases[1]).toHaveBeenCalledTimes(1))
  })
})
