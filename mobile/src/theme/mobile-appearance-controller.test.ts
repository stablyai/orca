import { describe, expect, it, vi } from 'vitest'
import {
  createMobileAppearanceController,
  parseMobileAppearance
} from './mobile-appearance-controller'

function fixture(value: unknown = null, system = 'light') {
  let listener = () => {}
  const apply = vi.fn()
  const write = vi.fn(async () => {})
  const controller = createMobileAppearanceController({
    read: async () => value,
    write,
    apply,
    systemScheme: () => system,
    onSystemChange: (next) => {
      listener = next
      return () => {}
    }
  })
  return {
    controller,
    apply,
    write,
    changeSystem: (next: string) => {
      system = next
      listener()
    }
  }
}

describe('mobile appearance preferences', () => {
  it('defaults to system and follows later system changes', async () => {
    const f = fixture()
    await f.controller.start()
    expect(f.controller.getSnapshot()).toMatchObject({ ready: true, preference: 'system' })
    expect(f.apply).toHaveBeenLastCalledWith('light')
    f.changeSystem('dark')
    expect(f.apply).toHaveBeenLastCalledWith('dark')
  })
  it.each(['light', 'dark'] as const)('restores %s and ignores system changes', async (scheme) => {
    const f = fixture(scheme)
    await f.controller.start()
    f.changeSystem(scheme === 'dark' ? 'light' : 'dark')
    expect(f.apply).toHaveBeenLastCalledWith(scheme)
  })
  it('persists choices in order and resumes system tracking immediately', async () => {
    const f = fixture('dark')
    await f.controller.start()
    const first = f.controller.setPreference('light')
    const second = f.controller.setPreference('system')
    await Promise.all([first, second])
    expect(f.write.mock.calls).toEqual([['light'], ['system']])
    expect(f.apply).toHaveBeenLastCalledWith('light')
    f.changeSystem('dark')
    expect(f.apply).toHaveBeenLastCalledWith('dark')
  })
  it('retains the saved choice and exposes an error if persistence fails', async () => {
    const f = fixture('dark')
    await f.controller.start()
    f.write.mockRejectedValueOnce(new Error('full storage'))
    await f.controller.setPreference('light')
    expect(f.controller.getSnapshot()).toMatchObject({
      preference: 'dark',
      error: expect.any(String)
    })
  })
  it('accepts missing or future preferences as system', () => {
    expect([null, 'unknown', {}, 2].map(parseMobileAppearance)).toEqual([
      'system',
      'system',
      'system',
      'system'
    ])
  })
  it('does not let a late startup read replace a successfully saved preference', async () => {
    let finish!: (value: string) => void
    const read = new Promise<string>((resolve) => {
      finish = resolve
    })
    const write = vi.fn(async () => {})
    const controller = createMobileAppearanceController({
      read: () => read,
      write,
      systemScheme: () => 'light',
      onSystemChange: () => () => {},
      apply: () => {}
    })
    const started = controller.start()
    await controller.setPreference('light')
    finish('dark')
    await started
    write.mockRejectedValueOnce(new Error('full storage'))
    await controller.setPreference('system')
    expect(controller.getSnapshot().preference).toBe('light')
  })
})
