import type * as nodeOs from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>()
  return { ...actual, homedir: homedirMock }
})

vi.mock('electron', () => ({ app: { isPackaged: true } }))

describe('patchPackagedProcessPath without an inherited HOME or PATH (#23214)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalHome = process.env.HOME
  const originalPath = process.env.PATH

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const [key, value] of [
      ['HOME', originalHome],
      ['PATH', originalPath]
    ] as const) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    homedirMock.mockReset()
  })

  function launchBareLinux(): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    delete process.env.HOME
    delete process.env.PATH
  }

  it('seeds HOME and the distro bins, keeping user bins behind them', async () => {
    const { patchPackagedProcessPath } = await import('./configure-process')
    launchBareLinux()
    homedirMock.mockReturnValue('/home/tester')

    patchPackagedProcessPath()

    expect(process.env.HOME).toBe('/home/tester')
    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain('/bin')
    expect(segments.every((segment) => isAbsolute(segment))).toBe(true)
    // #18234: a ~/.local/bin wrapper must not outrank the system gh.
    expect(segments.indexOf('/usr/bin')).toBeGreaterThan(-1)
    expect(segments.indexOf(join('/home/tester', '.local/bin'))).toBeGreaterThan(
      segments.indexOf('/usr/bin')
    )
  })

  it('still seeds the system bins when the account directory cannot be resolved', async () => {
    const { patchPackagedProcessPath } = await import('./configure-process')
    launchBareLinux()
    homedirMock.mockImplementation(() => {
      throw new Error('uv_os_homedir returned ENOENT')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    patchPackagedProcessPath()

    expect(process.env.HOME).toBeUndefined()
    const segments = (process.env.PATH ?? '').split(':')
    expect(segments).toContain('/usr/bin')
    expect(segments.every((segment) => isAbsolute(segment))).toBe(true)
  })
})
