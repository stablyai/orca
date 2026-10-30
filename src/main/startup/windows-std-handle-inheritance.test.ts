import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadWindowsSecurity } = vi.hoisted(() => ({ loadWindowsSecurity: vi.fn() }))
vi.mock('../../shared/windows-security-addon', () => ({ loadWindowsSecurity }))

import { clearWindowsStdHandleInheritance } from './windows-std-handle-inheritance'

function addonWith(clearStdHandleInheritance: () => unknown) {
  return { userSid: 'S-1-5-18', addon: { clearStdHandleInheritance } }
}

describe('clearWindowsStdHandleInheritance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    loadWindowsSecurity.mockReset()
  })

  it('is a no-op off Windows', () => {
    clearWindowsStdHandleInheritance('darwin')
    clearWindowsStdHandleInheritance('linux')

    expect(loadWindowsSecurity).not.toHaveBeenCalled()
  })

  it('clears the std handles through the addon on Windows', () => {
    const clear = vi.fn(() => [])
    loadWindowsSecurity.mockReturnValue(addonWith(clear))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    clearWindowsStdHandleInheritance('win32')

    expect(clear).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs each handle the addon could not clear', () => {
    loadWindowsSecurity.mockReturnValue(addonWith(() => [{ stream: 'stdout', code: 6 }]))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    clearWindowsStdHandleInheritance('win32')

    expect(warn).toHaveBeenCalledWith('[startup] stdout stays inheritable; Win32 error 6')
  })

  it('logs instead of throwing when the addon is unavailable', () => {
    loadWindowsSecurity.mockReturnValue({ error: 'missing binary' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => clearWindowsStdHandleInheritance('win32')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[startup] std handles stay inheritable; addon unavailable: missing binary'
    )
  })

  it('logs instead of throwing when the addon call throws, e.g. a stale binary', () => {
    loadWindowsSecurity.mockReturnValue(
      addonWith(() => {
        throw new TypeError('clearStdHandleInheritance is not a function')
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => clearWindowsStdHandleInheritance('win32')).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[startup] std handles stay inheritable:',
      expect.any(TypeError)
    )
  })
})
