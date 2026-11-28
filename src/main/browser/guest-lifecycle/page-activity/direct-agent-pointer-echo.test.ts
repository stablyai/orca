import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { DIRECT_POINTER_FRAME_MS, DirectAgentPointerEcho } from './direct-agent-pointer-echo'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { on: vi.fn() }
}))

const send = vi.fn()
const readViewport = vi.fn(async () => ({ width: 800, height: 600 }))
const markActive = vi.fn()
let visible = true
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the echo reads only id.
const guest = { id: 7 } as unknown as WebContents
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the echo calls only send and isDestroyed.
const renderer = { send, isDestroyed: () => false } as unknown as WebContents

function createEcho(): DirectAgentPointerEcho {
  return new DirectAgentPointerEcho({
    pageIdForGuest: () => 'page-1',
    rendererForPage: () => renderer,
    markActive,
    readViewport,
    isWindowVisible: () => visible
  })
}

// Lets the viewport read resolve without moving fake time, which would close the frame window.
async function settleViewportRead(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

const sentPoints = (): unknown[] =>
  send.mock.calls.map(([, event]) => [event.x, event.press, event.awaitsArrival])

beforeEach(() => {
  vi.useFakeTimers()
  visible = true
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('draws each point without waiting, reading the viewport off the input path', async () => {
  const echo = createEcho()
  echo.echo(guest, { type: 'mouseMoved', x: 1, y: 1 })
  await settleViewportRead()
  expect(send).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(DIRECT_POINTER_FRAME_MS)
  echo.echo(guest, { type: 'mousePressed', x: 2, y: 2 })

  // The second point used the cached viewport synchronously: no page read in between.
  expect(sentPoints()).toEqual([
    [1, false, false],
    [2, true, false]
  ])
  expect(readViewport).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[1][1]).toMatchObject({ viewportWidth: 800, viewportHeight: 600 })
  expect(markActive).toHaveBeenCalledWith('page-1')
  // Never a sequence Orca's helper could be waiting on.
  expect(send.mock.calls.every(([, event]) => event.sequence < 0)).toBe(true)
})

it('coalesces moves to one per frame, latest wins, and always sends a press', async () => {
  const echo = createEcho()
  echo.echo(guest, { type: 'mouseMoved', x: 1, y: 1 })
  await settleViewportRead()
  expect(send).toHaveBeenCalledTimes(1)
  echo.echo(guest, { type: 'mouseMoved', x: 2, y: 2 })
  echo.echo(guest, { type: 'mouseMoved', x: 3, y: 3 })
  expect(send).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(DIRECT_POINTER_FRAME_MS)
  echo.echo(guest, { type: 'mouseMoved', x: 4, y: 4 })
  echo.echo(guest, { type: 'mousePressed', x: 5, y: 5 })

  expect(sentPoints()).toEqual([
    [1, false, false],
    [3, false, false],
    [5, true, false]
  ])
})

it("sends nothing while the user's window is not visible", async () => {
  visible = false
  const echo = createEcho()
  echo.echo(guest, { type: 'mousePressed', x: 1, y: 1 })
  await settleViewportRead()
  expect(readViewport).toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('keeps a directly driven page lit through rapid input and unmarks it only after idling', async () => {
  const { BrowserAgentActivity } = await import('./browser-agent-activity')
  const { AGENT_PAGE_ACTIVITY_IDLE_MS } =
    await import('../../agent-browser/session-routing/person-pick-hold')
  const activity = new BrowserAgentActivity({
    pageIdForGuest: () => 'page-1',
    rendererForPage: () => renderer,
    worktreeForPage: () => null
  })
  const marks = (): unknown[] => send.mock.calls.map(([, event]) => event.active)

  for (let i = 0; i < 5; i += 1) {
    vi.advanceTimersByTime(30)
    activity.markDirectInput('page-1')
  }
  expect(marks()).toEqual([true])
  vi.advanceTimersByTime(AGENT_PAGE_ACTIVITY_IDLE_MS - 1)
  expect(activity.isActive('page-1')).toBe(true)
  vi.advanceTimersByTime(1)
  expect(marks()).toEqual([true, false])
})
