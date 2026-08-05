import { describe, expect, it, vi } from 'vitest'
import { wakeMacosDisplay } from './macos-display-wake'
import { wakeLinuxDisplay } from './linux-display-wake'

describe('display wake helpers', () => {
  it('spawns caffeinate -u on macOS to turn the display on', () => {
    const child = { unref: vi.fn() }
    const spawn = vi.fn(() => child)

    wakeMacosDisplay({ platform: 'darwin', spawn, timeoutSeconds: 5 })

    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-u', '-t', '5'], {
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.unref).toHaveBeenCalled()
  })

  it('skips macOS wake on non-darwin platforms', () => {
    const spawn = vi.fn()
    wakeMacosDisplay({ platform: 'linux', spawn })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forces DPMS on when Linux has a DISPLAY', () => {
    const child = { unref: vi.fn() }
    const spawn = vi.fn(() => child)

    wakeLinuxDisplay({
      platform: 'linux',
      env: { DISPLAY: ':0' } as NodeJS.ProcessEnv,
      spawn
    })

    expect(spawn).toHaveBeenCalledWith('xset', ['dpms', 'force', 'on'], {
      stdio: 'ignore',
      windowsHide: true,
      env: expect.objectContaining({ DISPLAY: ':0' })
    })
    expect(child.unref).toHaveBeenCalled()
  })

  it('skips Linux wake without DISPLAY', () => {
    const spawn = vi.fn()
    wakeLinuxDisplay({
      platform: 'linux',
      env: {} as NodeJS.ProcessEnv,
      spawn
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})
