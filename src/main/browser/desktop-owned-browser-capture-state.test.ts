import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnedBrowserCaptureFixture } from './desktop-owned-browser-capture-test-fixture'
import {
  readOwnedCaptureViewportState,
  restoreOwnedCaptureViewport
} from './desktop-owned-browser-capture-state'

describe('owned capture viewport restoration', () => {
  afterEach(() => vi.useRealTimers())

  it('preserves fractional DPR and scroll without rounding the page state', async () => {
    const f = createOwnedBrowserCaptureFixture()
    f.properties.devicePixelRatio = 1.25
    f.properties.scrollX = 0.8
    f.properties.scrollY = 80.8
    const original = await readOwnedCaptureViewportState(f.record.webContents)
    f.properties.scrollY = 24
    await restoreOwnedCaptureViewport(f.record.webContents, original)
    expect(f.properties.scrollWrites).toEqual([{ x: 0.8, y: 80.8 }])
    expect(await readOwnedCaptureViewportState(f.record.webContents)).toEqual(original)
    await f.controller.close()
  })

  it.each([
    ['innerWidth', 0],
    ['innerHeight', 2.5],
    ['innerWidth', 2 ** 31],
    ['devicePixelRatio', 0],
    ['devicePixelRatio', Number.POSITIVE_INFINITY],
    ['scrollY', Number.NaN],
    ['timeOrigin', -1]
  ])('rejects invalid viewport field %s=%s', async (field, value) => {
    const f = createOwnedBrowserCaptureFixture()
    f.sendCommand.mockResolvedValue({
      result: {
        value: {
          innerWidth: 100,
          innerHeight: 100,
          devicePixelRatio: 1,
          scrollX: 0,
          scrollY: 81,
          timeOrigin: 12345,
          [field]: value
        }
      }
    })
    await expect(readOwnedCaptureViewportState(f.record.webContents)).rejects.toThrow()
    expect(f.properties.scrollWrites).toEqual([])
    await f.controller.close()
  })

  it('rejects an evaluation exception before using its response', async () => {
    const f = createOwnedBrowserCaptureFixture()
    f.sendCommand.mockResolvedValue({ result: { value: {} }, exceptionDetails: null })
    await expect(readOwnedCaptureViewportState(f.record.webContents)).rejects.toThrow(
      'Unable to read owned browser capture viewport'
    )
    await f.controller.close()
  })

  it('does not scroll a document that replaced the captured page', async () => {
    vi.useFakeTimers()
    const f = createOwnedBrowserCaptureFixture()
    const original = await readOwnedCaptureViewportState(f.record.webContents)
    f.properties.timeOrigin += 1
    const restored = expect(
      restoreOwnedCaptureViewport(f.record.webContents, original)
    ).rejects.toThrow('Owned browser page navigated during capture')
    await vi.advanceTimersByTimeAsync(1000)
    await restored
    expect(f.properties.scrollWrites).toEqual([])
    await f.controller.close()
  })

  it('keeps the document check in the scroll evaluation across asynchronous navigation', async () => {
    const f = createOwnedBrowserCaptureFixture()
    const original = await readOwnedCaptureViewportState(f.record.webContents)
    const send = f.sendCommand.getMockImplementation()!
    f.sendCommand.mockImplementation(async (method, params) => {
      const expression = String(params?.expression)
      if (expression.includes('window.scrollTo')) {
        expect(expression).toContain(`performance.timeOrigin !== ${original.timeOrigin}`)
        return { result: {}, exceptionDetails: { text: 'Browser document changed' } }
      }
      return send(method, params)
    })
    await expect(restoreOwnedCaptureViewport(f.record.webContents, original)).rejects.toThrow(
      'Unable to restore owned browser capture scroll position'
    )
    expect(f.properties.scrollWrites).toEqual([])
    await f.controller.close()
  })
})
