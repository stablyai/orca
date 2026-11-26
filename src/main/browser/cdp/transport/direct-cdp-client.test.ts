import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import type { AgentPointer } from '../input/cdp-page-input-commands'
import { DIRECT_CDP_CLIENT_POINTER } from './direct-cdp-client'
import {
  connect,
  createMockWebContents,
  getSendCommandCalls,
  mockAsWebContents,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

const MOVE = {
  id: 1,
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mouseMoved', x: 5, y: 5 }
}
const PRESS = {
  id: 2,
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }
}

let proxy: CdpWsProxy | null = null
let ws: WebSocket | null = null

afterEach(async () => {
  ws?.close()
  await proxy?.stop()
  proxy = null
  ws = null
})

// Chromium acks a move only on the guest's next frame, which a throttled guest may not draw for ~1 s.
async function embeddedGuestNeverAckingMoves(pointer: AgentPointer) {
  const mock = createMockWebContents()
  mock.webContents.getType.mockReturnValue('webview')
  Object.assign(mock.webContents, { isOffscreen: () => false })
  mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) =>
    method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved'
      ? new Promise<Record<string, unknown>>(() => {})
      : {}
  )
  proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {}, undefined, pointer)
  ws = await connect(await proxy.start())
  return { mock, ws }
}

it('answers a direct client hover move at once and delivers the press after it', async () => {
  const { mock, ws } = await embeddedGuestNeverAckingMoves(DIRECT_CDP_CLIENT_POINTER)

  expect(await sendAndReceive(ws, MOVE)).toMatchObject({ id: 1, result: {} })
  expect(await sendAndReceive(ws, PRESS)).toMatchObject({ id: 2, result: {} })
  const mouse = getSendCommandCalls(mock).filter(
    ([method]) => method === 'Input.dispatchMouseEvent'
  )
  expect(mouse.map(([, params]) => params?.type)).toEqual(['mouseMoved', 'mousePressed'])
})

it("keeps Orca's own helper drawing the cursor and waiting for the move ack", async () => {
  const show = vi.fn(async () => {})
  const { mock, ws } = await embeddedGuestNeverAckingMoves({ show, skipsInputWaits: () => false })
  const answered: unknown[] = []
  ws.on('message', (data) => answered.push(JSON.parse(data.toString()).id))

  ws.send(JSON.stringify(MOVE))
  ws.send(JSON.stringify(PRESS))
  // The proxy reads messages in order, so this reply means it has already taken the press.
  expect(
    await sendAndReceive(ws, { id: 3, method: 'Runtime.evaluate', params: { expression: '1' } })
  ).toMatchObject({ id: 3 })

  expect(show).toHaveBeenCalledWith(MOVE.params)
  expect(answered).not.toContain(1)
  const mouse = getSendCommandCalls(mock).filter(
    ([method]) => method === 'Input.dispatchMouseEvent'
  )
  expect(mouse.map(([, params]) => params?.type)).toEqual(['mouseMoved'])
})
