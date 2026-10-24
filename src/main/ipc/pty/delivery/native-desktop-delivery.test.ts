import { afterEach, describe, expect, it, vi } from 'vitest'

const frames = vi.hoisted(() => new Map<number, { channel: string; values: unknown[] }[]>())

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Contents extends EventEmitter {
    id = ++serial
    private gone = false
    isDestroyed = (): boolean => this.gone
    getURL = (): string => 'file:///orca/index.html'
    isLoadingMainFrame = (): boolean => false
    send = (channel: string, ...values: unknown[]): void => {
      const list = frames.get(this.id) ?? []
      list.push({ channel, values })
      frames.set(this.id, list)
    }
    destroy = (): void => {
      this.gone = true
      this.emit('destroyed')
    }
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    isDestroyed = (): boolean => this.webContents.isDestroyed()
    isFocused = (): boolean => false
    isVisible = (): boolean => false
    isMinimized = (): boolean => false
    destroy = (): void => this.webContents.destroy()
    static getFocusedWindow = () => null
  }
  return { BrowserWindow: Window }
})
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => null }))

import { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import { createPtyIpcSession } from '../session'
import { wirePtyIpcSession } from './wire-session'
import { NativeDesktopPtyDelivery } from './native-desktop-delivery'
import { applyCumulativeAck } from './accounting'
import { PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS } from './constants'

const windows: BrowserWindow[] = []

function fixture() {
  vi.useFakeTimers()
  const settings = () => ({ ...getDefaultSettings('C:/test'), terminalHiddenDeliveryGate: false })
  const delivery = new NativeDesktopPtyDelivery({ getPtyOutputSequence: () => 100 }, settings)
  const first = new BrowserWindow({ show: false })
  const second = new BrowserWindow({ show: false })
  windows.push(first, second)
  delivery.add(first)
  delivery.add(second)
  const source = createPtyIpcSession({
    mainWindow: delivery.source,
    getSettings: settings,
    options: {
      nativeWindowDelivery: {
        attachSource: (session) => delivery.attachSource(session),
        acceptData: (payload) => delivery.acceptData(payload),
        sessionFor: (renderer) => delivery.sessionFor(renderer),
        claim: (renderer, id) => delivery.claim(renderer, id),
        canResize: (renderer, id) => delivery.canResize(renderer, id),
        canReply: (renderer, id) => delivery.canReply(renderer, id),
        updateHint: (renderer, id, hint, value) => delivery.updateHint(renderer, id, hint, value)
      }
    }
  })
  wirePtyIpcSession(source)
  delivery.attachSource(source)
  const a = delivery.sessionFor(first.webContents)
  const b = delivery.sessionFor(second.webContents)
  if (!a || !b) {
    throw new Error('Missing per-window delivery')
  }
  a.rendererPtyDispatcherReady = true
  b.rendererPtyDispatcherReady = true
  return { delivery, first, second, source, a, b }
}

afterEach(() => {
  for (const window of windows.splice(0)) {
    window.destroy()
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  frames.clear()
})

describe('native desktop terminal output delivery', () => {
  it('isolates acknowledgments and keeps another window receiving when one queue is blocked', () => {
    const { delivery, first, second, source, a, b } = fixture()
    const data = 'x'.repeat(PTY_RENDERER_IN_FLIGHT_HIGH_WATER_CHARS)
    source.sendPtyDataToRenderer('pty', { id: 'pty', data })
    vi.advanceTimersByTime(200)
    expect(a.getRendererInFlightCharsForPty('pty')).toBeGreaterThan(0)
    expect(b.getRendererInFlightCharsForPty('pty')).toBeGreaterThan(0)
    const firstCredit = a.getRendererInFlightCharsForPty('pty')
    applyCumulativeAck(b, 'pty', data.length)
    b.schedulePendingDataAfterCreditReport(true)
    source.sendPtyDataToRenderer('pty', { id: 'pty', data: 'second-window-live' })
    vi.advanceTimersByTime(200)

    expect(a.getRendererInFlightCharsForPty('pty')).toBe(firstCredit)
    expect(
      frames
        .get(second.webContents.id)
        ?.some((frame) => JSON.stringify(frame).includes('second-window-live'))
    ).toBe(true)
    first.destroy()
    expect(delivery.sessionFor(second.webContents)).toBe(b)
    source.sendPtyDataToRenderer('pty', { id: 'pty', data: 'after-first-close' })
    vi.advanceTimersByTime(200)
    expect(
      frames
        .get(second.webContents.id)
        ?.some((frame) => JSON.stringify(frame).includes('after-first-close'))
    ).toBe(true)
  })

  it('flushes buffered terminal output before the per-window exit notice', () => {
    const { second, source } = fixture()
    source.sendPtyDataToRenderer('pty', { id: 'pty', data: 'last-output' })
    source.mainWindow?.webContents.send('pty:exit', { id: 'pty', code: 0 })
    const sent = frames.get(second.webContents.id) ?? []
    expect(sent.map((frame) => frame.channel)).toEqual(['pty:data', 'pty:exit'])
    expect(sent[0]?.values).toEqual([{ id: 'pty', data: 'last-output' }])
  })

  it('keeps visibility aggregated and elects only one query-reply and resize driver', () => {
    const { delivery, first, second } = fixture()
    expect(delivery.updateHint(first.webContents, 'pty', 'visible', true)).toBe(true)
    expect(delivery.updateHint(second.webContents, 'pty', 'visible', false)).toBe(true)
    expect(delivery.updateHint(second.webContents, 'pty', 'hidden', true)).toBe(false)
    delivery.claim(first.webContents, 'pty')
    expect(delivery.canReply(first.webContents, 'pty')).toBe(true)
    expect(delivery.canReply(second.webContents, 'pty')).toBe(false)
    expect(delivery.canResize(second.webContents, 'pty')).toBe(false)
    first.destroy()
    expect(delivery.canResize(second.webContents, 'pty')).toBe(true)
    expect(delivery.updateHint(second.webContents, 'pty', 'hidden', true)).toBe(true)
  })
})
