import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loadHostCatalogMock, removeHostAndCloseClientMock, forgetHostClientMock } = vi.hoisted(
  () => ({
    loadHostCatalogMock: vi.fn(),
    removeHostAndCloseClientMock: vi.fn(),
    forgetHostClientMock: vi.fn()
  })
)

vi.mock('expo-router', () => ({
  usePathname: () => '/h/host-1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() })
}))
vi.mock('../transport/client-context', () => ({
  useForgetHostClient: () => forgetHostClientMock,
  useForceReconnect: () => vi.fn()
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: () => loadHostCatalogMock() }))
vi.mock('../transport/host-removal-lifecycle', () => ({
  removeHostAndCloseClient: (hostId: string, key: string, forget: (id: string) => void) =>
    removeHostAndCloseClientMock(hostId, key, forget)
}))
vi.mock('../mobile-web/mobile-web-native-capability-authority', () => ({
  MOBILE_WEB_NATIVE_CAPABILITY_AUTHORITY: { openExternal: vi.fn() }
}))

import { useDefaultHostScreenShellOperations } from './default-host-screen-shell-operations'
import type { HostScreenShellOperations } from './host-screen-shell-operations'

describe('default host screen shell operations', () => {
  let renderer: ReactTestRenderer | null = null
  let operations: HostScreenShellOperations | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    operations = null
    loadHostCatalogMock.mockReset()
    removeHostAndCloseClientMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(): void {
    function Probe(): null {
      operations = useDefaultHostScreenShellOperations({ hostId: 'host-1', embedded: false })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
  }

  // Why: Remove used to take the key from host-screen state, which an async storage read
  // fills — tapping before it resolved rejected with "Host identity unavailable".
  it('resolves the hybrid cache key itself instead of taking it from the caller', async () => {
    loadHostCatalogMock.mockResolvedValue([
      { id: 'host-0', publicKeyB64: 'other-key' },
      { id: 'host-1', publicKeyB64: 'host-1-key' }
    ])
    render()

    await act(async () => {
      await operations?.removeHost()
    })

    expect(removeHostAndCloseClientMock).toHaveBeenCalledWith(
      'host-1',
      'host-1-key',
      forgetHostClientMock
    )
  })

  it('still unpairs when the host list cannot be read', async () => {
    loadHostCatalogMock.mockRejectedValue(new Error('storage unreadable'))
    render()

    await act(async () => {
      await operations?.removeHost()
    })

    expect(removeHostAndCloseClientMock).toHaveBeenCalledWith('host-1', '', forgetHostClientMock)
  })
})
