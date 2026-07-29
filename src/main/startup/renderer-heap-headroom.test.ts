import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRendererHeapCeilingMb } from './renderer-heap-headroom'

vi.mock('electron', () => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: vi.fn(() => '')
    }
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const GIB = 1024 * 1024 * 1024

describe('computeRendererHeapCeilingMb', () => {
  it('leaves Chromium default (null) below the ~8 GB gate to avoid OS memory pressure', () => {
    expect(computeRendererHeapCeilingMb(4 * GIB)).toBeNull()
    expect(computeRendererHeapCeilingMb(6 * GIB)).toBeNull() // 6 GB reports ~5.7 GiB
    expect(computeRendererHeapCeilingMb(7 * GIB)).toBeNull() // below the 7.5 GiB gate
  })

  it('includes 8 GB machines that report below 8 GiB (Linux MemTotal excludes reserved RAM)', () => {
    // A real 8 GB Linux box reports ~7.7 GiB; it must still get the headroom.
    expect(computeRendererHeapCeilingMb(7.7 * GIB)).toBe(3072)
    expect(computeRendererHeapCeilingMb(7.5 * GIB)).toBe(3072)
  })

  it('raises the ceiling toward the 4 GB pointer-compression cage, floored and capped', () => {
    expect(computeRendererHeapCeilingMb(8 * GIB)).toBe(3072) // floor: 8 GB default ~2.2 GB -> 3072
    expect(computeRendererHeapCeilingMb(12 * GIB)).toBe(4096) // 0.4*12 -> 4096 (cage)
    expect(computeRendererHeapCeilingMb(16 * GIB)).toBe(4096) // cage cap
    expect(computeRendererHeapCeilingMb(128 * GIB)).toBe(4096) // cage cap, never higher
  })

  it('honors a positive ORCA_RENDERER_HEAP_MB override regardless of RAM', () => {
    expect(computeRendererHeapCeilingMb(4 * GIB, '5000')).toBe(5000)
    expect(computeRendererHeapCeilingMb(128 * GIB, '4096')).toBe(4096)
  })

  it('opts out (null) for default/off/none/0/negative overrides', () => {
    for (const value of ['default', 'off', 'none', '0', '-1']) {
      expect(computeRendererHeapCeilingMb(16 * GIB, value)).toBeNull()
    }
  })

  it('opts out (null) for a fractional override that would floor to 0 (never emits max-old-space-size=0)', () => {
    for (const value of ['0.5', '0.9', '0.0001']) {
      expect(computeRendererHeapCeilingMb(16 * GIB, value)).toBeNull()
    }
  })

  it('falls through to RAM tiers for blank/invalid overrides', () => {
    expect(computeRendererHeapCeilingMb(16 * GIB, '')).toBe(4096)
    expect(computeRendererHeapCeilingMb(16 * GIB, 'abc')).toBe(4096)
  })

  it('returns null for a non-finite / non-positive RAM reading', () => {
    expect(computeRendererHeapCeilingMb(Number.NaN)).toBeNull()
    expect(computeRendererHeapCeilingMb(0)).toBeNull()
  })
})

describe('enableRendererHeapHeadroom', () => {
  it('appends --max-old-space-size as a js-flags switch on a RAM-capable machine', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--max-old-space-size=4096'
    )
  })

  it('does not set a switch on low-RAM machines', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('')

    enableRendererHeapHeadroom({ totalMemoryBytes: 4 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('js-flags', expect.anything())
  })

  it('preserves an explicit prior --max-old-space-size instead of stacking a second value', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('--max-old-space-size=2048')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('js-flags', expect.anything())
  })

  it('merges with an unrelated existing js-flags value', async () => {
    const { app } = await import('electron')
    const { enableRendererHeapHeadroom } = await import('./renderer-heap-headroom')

    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('--no-opt')

    enableRendererHeapHeadroom({ totalMemoryBytes: 16 * GIB, env: {} })

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'js-flags',
      '--no-opt --max-old-space-size=4096'
    )
  })
})
