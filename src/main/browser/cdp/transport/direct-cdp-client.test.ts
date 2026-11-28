import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import type { AgentPointer } from '../input/cdp-page-input-commands'
import { directCdpClientPointer } from './direct-cdp-client'
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
  vi.useRealTimers()
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
  const echoed: unknown[] = []
  const { mock, ws } = await embeddedGuestNeverAckingMoves(
    directCdpClientPointer((input) => echoed.push(input.type))
  )

  expect(await sendAndReceive(ws, MOVE)).toMatchObject({ id: 1, result: {} })
  expect(await sendAndReceive(ws, PRESS)).toMatchObject({ id: 2, result: {} })
  const mouse = getSendCommandCalls(mock).filter(
    ([method]) => method === 'Input.dispatchMouseEvent'
  )
  expect(mouse.map(([, params]) => params?.type)).toEqual(['mouseMoved', 'mousePressed'])
  // The cursor is echoed after the input went out, and drawing it never held the input.
  await vi.waitFor(() => expect(echoed).toEqual(['mouseMoved', 'mousePressed']))
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

const KEY_A = {
  id: 4,
  method: 'Input.dispatchKeyEvent',
  params: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 }
}

// A focused field in the page, which never reports that it finished handling typed input.
async function embeddedGuestNeverSettlingKeys(pointer: AgentPointer) {
  const mock = createMockWebContents()
  mock.webContents.getType.mockReturnValue('webview')
  Object.assign(mock.webContents, { isOffscreen: () => false })
  mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
    const expression = typeof params?.expression === 'string' ? params.expression : ''
    if (method === 'Runtime.evaluate' && expression.includes('MessageChannel')) {
      return new Promise<Record<string, unknown>>(() => {})
    }
    if (method === 'Runtime.evaluate' && expression.includes('document.activeElement')) {
      return { result: { type: 'boolean', value: true } }
    }
    return {}
  })
  proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {}, undefined, pointer)
  ws = await connect(await proxy.start())
  // Freeze the page probe's 500 ms fallback, so a key answered only by waiting never is.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return { mock, ws }
}

it('answers a direct client typed key once it is sent to the page', async () => {
  const { mock, ws } = await embeddedGuestNeverSettlingKeys(directCdpClientPointer(() => {}))

  expect(await sendAndReceive(ws, KEY_A)).toMatchObject({ id: 4, result: {} })
  expect(mock.webContents.sendInputEvent).toHaveBeenCalled()
})

it("keeps Orca's own helper waiting for the page to handle a typed key", async () => {
  const { mock, ws } = await embeddedGuestNeverSettlingKeys({
    show: async () => {},
    skipsInputWaits: () => false
  })
  const answered: unknown[] = []
  ws.on('message', (data) => answered.push(JSON.parse(data.toString()).id))

  ws.send(JSON.stringify(KEY_A))
  await vi.waitFor(() => expect(mock.webContents.sendInputEvent).toHaveBeenCalled())
  // A forwarded command's reply comes after the key reached the page; the key itself stays unanswered.
  expect(
    await sendAndReceive(ws, { id: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
  ).toMatchObject({ id: 5 })
  expect(answered).not.toContain(4)
})
