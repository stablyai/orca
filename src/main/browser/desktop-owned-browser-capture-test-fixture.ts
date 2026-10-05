import type { BrowserWindow } from 'electron'
import { vi, type Mock } from 'vitest'
import { createOwnedViewFixture } from './desktop-owned-browser-view-test-fixture'

type OwnedViewFixture = ReturnType<typeof createOwnedViewFixture>

export type OwnedBrowserCaptureFixture = OwnedViewFixture & {
  guest: OwnedViewFixture['guest'] & {
    isCrashed: () => boolean
    invalidate: Mock<() => void>
    capturePage: Mock<() => unknown>
    debugger: {
      isAttached: () => boolean
      attach: Mock<() => void>
      detach: Mock<() => void>
      sendCommand: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>
    }
  }
  owner: BrowserWindow
  properties: {
    scrollX: number
    scrollY: number
    scrollWrites: { x: number; y: number }[]
    timeOrigin: number
    devicePixelRatio: number
    contentWidth: number
    contentHeight: number
    viewportWidth?: number
    viewportHeight?: number
    zoomFactor: number
  }
  captures: { bounds: Electron.Rectangle; params: unknown }[]
  sendCommand: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>
}

export function createOwnedBrowserCaptureFixture(): OwnedBrowserCaptureFixture {
  const fixture = createOwnedViewFixture({ visible: false })
  const properties: OwnedBrowserCaptureFixture['properties'] = {
    scrollX: 0,
    scrollY: 81,
    scrollWrites: [],
    timeOrigin: 12345,
    devicePixelRatio: 1,
    contentWidth: 1152,
    contentHeight: 2728,
    zoomFactor: 1
  }
  const captures: { bounds: Electron.Rectangle; params: unknown }[] = []
  const sendCommand = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssContentSize: { width: properties.contentWidth, height: properties.contentHeight }
        }
      }
      if (method === 'Emulation.setVisibleSize') {
        properties.viewportWidth = Number(params?.width) / properties.zoomFactor
        properties.viewportHeight = Number(params?.height) / properties.zoomFactor
        return {}
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression)
        if (expression.includes('window.scrollTo')) {
          const match = /left:([-\d.]+),top:([-\d.]+)/u.exec(expression)
          if (match) {
            properties.scrollX = Number(match[1])
            properties.scrollY = Number(match[2])
            properties.scrollWrites.push({ x: properties.scrollX, y: properties.scrollY })
          }
          return { result: { value: true } }
        }
        return {
          result: {
            value: {
              innerWidth: properties.viewportWidth ?? fixture.state.bounds.width,
              innerHeight: properties.viewportHeight ?? fixture.state.bounds.height,
              timeOrigin: properties.timeOrigin,
              devicePixelRatio: properties.devicePixelRatio,
              scrollX: properties.scrollX,
              scrollY: properties.scrollY
            }
          }
        }
      }
      if (method === 'Page.captureScreenshot') {
        captures.push({ bounds: { ...fixture.state.bounds }, params })
        return { data: 'owned-page-pixels' }
      }
      throw new Error(`Unexpected capture fixture method ${method}`)
    }
  )
  const guest = Object.assign(fixture.guest, {
    isCrashed: () => false,
    getZoomFactor: () => properties.zoomFactor,
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand }
  })
  const ownerShape = {
    ...fixture.host,
    getBounds: () => ({ x: 30, y: 60, width: 1200, height: 800 })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads owner lifetime; fixture supplies child attachment.
  const owner = ownerShape as unknown as BrowserWindow
  return { ...fixture, guest, owner, properties, captures, sendCommand }
}
