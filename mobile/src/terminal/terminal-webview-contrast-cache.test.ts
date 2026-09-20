// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'

type CachedColor = { css: string; rgba: number }
type ContrastCache = {
  setColor(bg: number, fg: number, value: CachedColor | null): void
  getColor(bg: number, fg: number): CachedColor | null | undefined
  setCss(bg: number, fg: number, value: string | null): void
  getCss(bg: number, fg: number): string | null | undefined
  _color: { _data: Record<number, Record<number, CachedColor | null>> }
  _css: { _data: Record<number, Record<number, string | null>> }
}
type TerminalWithInternals = InstanceType<typeof Terminal> & {
  options: { theme: { background: string } }
  _core: {
    _themeService: { colors: { contrastCache: ContrastCache; halfContrastCache: ContrastCache } }
  }
}

const entries = (cache: ContrastCache): number =>
  [cache._color, cache._css].reduce(
    (total, map) =>
      total + Object.values(map._data).reduce((count, row) => count + Object.keys(row).length, 0),
    0
  )

describe('the mobile bundled xterm contrast caches', () => {
  let terminal: TerminalWithInternals
  let cache: ContrastCache
  let dimCache: ContrastCache

  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    // Happy DOM has no font rasterizer; cache behavior uses the real bundled implementation.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's DOM font probe only reads font and measureText from this canvas context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: () => ({ width: 8 })
    } as unknown as CanvasRenderingContext2D)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test reads xterm's private theme-service cache to verify the patched package; Terminal's public API is unchanged.
    terminal = new Terminal({ minimumContrastRatio: 3 }) as TerminalWithInternals
    document.body.innerHTML = '<div id="terminal"></div>'
    terminal.open(document.getElementById('terminal')!)
    cache = terminal._core._themeService.colors.contrastCache
    dimCache = terminal._core._themeService.colors.halfContrastCache
  })

  afterEach(() => {
    terminal?.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('counts cached nulls and leaves replacement writes within capacity', () => {
    for (let index = 0; index < 4096; index++) {
      cache.setColor(0, index, null)
    }
    const corrected = { css: '#ffffff', rgba: 0xffffffff }
    for (let index = 0; index < 10000; index++) {
      cache.setColor(0, 4095, corrected)
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(cache.getColor(0, 4095)).toBe(corrected)
    expect(entries(cache)).toBe(4096)
    cache.setColor(0, 4096, null)
    expect(cache.getColor(0, 0)).toBeUndefined()
    expect(entries(cache)).toBe(1)
  })

  it('bounds mixed color/CSS entries in both normal and dim caches', () => {
    for (let index = 0; index < 100000; index++) {
      cache.setColor(index, 0, null)
      cache.setCss(index, 1, '#ffffff')
      dimCache.setColor(index, 0, null)
      dimCache.setCss(index, 1, '#eeeeee')
      if (index % 2048 === 2047) {
        expect(entries(cache)).toBeLessThanOrEqual(4096)
        expect(entries(dimCache)).toBeLessThanOrEqual(4096)
      }
    }
    expect(cache.getCss(99999, 1)).toBe('#ffffff')
    expect(dimCache.getCss(99999, 1)).toBe('#eeeeee')
    expect(entries(cache) + entries(dimCache)).toBeLessThanOrEqual(8192)
  })

  it('resets both capacities when the actual theme service clears them', () => {
    for (let index = 0; index < 4096; index++) {
      cache.setColor(index, 0, null)
      dimCache.setCss(index, 0, null)
    }
    terminal.options.theme = { background: '#123456' }
    expect(entries(cache)).toBe(0)
    expect(entries(dimCache)).toBe(0)
    for (let index = 0; index < 4096; index++) {
      cache.setColor(index, 0, null)
      dimCache.setCss(index, 0, null)
    }
    expect(cache.getColor(0, 0)).toBeNull()
    expect(dimCache.getCss(0, 0)).toBeNull()
  })
})
