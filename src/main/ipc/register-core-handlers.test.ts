import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  registerCliHandlersMock,
  registerPreflightHandlersMock,
  registerGitHubHandlersMock,
  registerSettingsHandlersMock,
  registerShellHandlersMock,
  registerSessionHandlersMock,
  registerUIHandlersMock,
  registerFilesystemHandlersMock,
  registerRuntimeHandlersMock,
  registerClipboardHandlersMock,
  registerUpdaterHandlersMock
} = vi.hoisted(() => ({
  registerCliHandlersMock: vi.fn(),
  registerPreflightHandlersMock: vi.fn(),
  registerGitHubHandlersMock: vi.fn(),
  registerSettingsHandlersMock: vi.fn(),
  registerShellHandlersMock: vi.fn(),
  registerSessionHandlersMock: vi.fn(),
  registerUIHandlersMock: vi.fn(),
  registerFilesystemHandlersMock: vi.fn(),
  registerRuntimeHandlersMock: vi.fn(),
  registerClipboardHandlersMock: vi.fn(),
  registerUpdaterHandlersMock: vi.fn()
}))

vi.mock('./cli', () => ({
  registerCliHandlers: registerCliHandlersMock
}))

vi.mock('./preflight', () => ({
  registerPreflightHandlers: registerPreflightHandlersMock
}))

vi.mock('./github', () => ({
  registerGitHubHandlers: registerGitHubHandlersMock
}))

vi.mock('./settings', () => ({
  registerSettingsHandlers: registerSettingsHandlersMock
}))

vi.mock('./shell', () => ({
  registerShellHandlers: registerShellHandlersMock
}))

vi.mock('./session', () => ({
  registerSessionHandlers: registerSessionHandlersMock
}))

vi.mock('./ui', () => ({
  registerUIHandlers: registerUIHandlersMock
}))

vi.mock('./filesystem', () => ({
  registerFilesystemHandlers: registerFilesystemHandlersMock
}))

vi.mock('./runtime', () => ({
  registerRuntimeHandlers: registerRuntimeHandlersMock
}))

vi.mock('../window/attach-main-window-services', () => ({
  registerClipboardHandlers: registerClipboardHandlersMock,
  registerUpdaterHandlers: registerUpdaterHandlersMock
}))

import { registerCoreHandlers } from './register-core-handlers'

describe('registerCoreHandlers', () => {
  beforeEach(() => {
    registerCliHandlersMock.mockReset()
    registerPreflightHandlersMock.mockReset()
    registerGitHubHandlersMock.mockReset()
    registerSettingsHandlersMock.mockReset()
    registerShellHandlersMock.mockReset()
    registerSessionHandlersMock.mockReset()
    registerUIHandlersMock.mockReset()
    registerFilesystemHandlersMock.mockReset()
    registerRuntimeHandlersMock.mockReset()
    registerClipboardHandlersMock.mockReset()
    registerUpdaterHandlersMock.mockReset()
  })

  it('passes the store through to handler registrars that need it', () => {
    const store = { marker: 'store' }
    const runtime = { marker: 'runtime' }

    registerCoreHandlers(store as never, runtime as never)

    expect(registerGitHubHandlersMock).toHaveBeenCalledWith(store)
    expect(registerSettingsHandlersMock).toHaveBeenCalledWith(store)
    expect(registerSessionHandlersMock).toHaveBeenCalledWith(store)
    expect(registerUIHandlersMock).toHaveBeenCalledWith(store)
    expect(registerFilesystemHandlersMock).toHaveBeenCalledWith(store)
    expect(registerRuntimeHandlersMock).toHaveBeenCalledWith(runtime)
    expect(registerCliHandlersMock).toHaveBeenCalled()
    expect(registerPreflightHandlersMock).toHaveBeenCalled()
    expect(registerShellHandlersMock).toHaveBeenCalled()
    expect(registerClipboardHandlersMock).toHaveBeenCalled()
    expect(registerUpdaterHandlersMock).toHaveBeenCalled()
  })
})
