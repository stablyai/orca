import { session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionsByPartition, fromPartition, fromPartitionMock } = vi.hoisted(() => {
  const createSession = () => ({
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {})
  })
  const sessionsByPartition = new Map<string, ReturnType<typeof createSession>>()
  const fromPartition = (partition: string): ReturnType<typeof createSession> => {
    const existing = sessionsByPartition.get(partition)
    if (existing) {
      return existing
    }
    const created = createSession()
    sessionsByPartition.set(partition, created)
    return created
  }
  return { sessionsByPartition, fromPartition, fromPartitionMock: vi.fn(fromPartition) }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT'), setProxy: vi.fn(async () => {}) },
    fromPartition: fromPartitionMock
  }
}))

import {
  applyBrowserSessionProxies,
  applyProxyToBrowserSession,
  invalidateBrowserSessionProxyApplication,
  setBrowserNetworkProxySettingsResolver
} from './browser-session-proxy'
import { releaseProxySessionApplication } from '../../../network/proxy-settings'

describe('browser session proxy', () => {
  beforeEach(() => {
    sessionsByPartition.clear()
    fromPartitionMock.mockReset().mockImplementation(fromPartition)
    setBrowserNetworkProxySettingsResolver(null)
  })

  afterEach(() => {
    setBrowserNetworkProxySettingsResolver(null)
    vi.restoreAllMocks()
  })

  it('applies a new proxy only to the partition that remains active during installation', async () => {
    let proxyUrl = 'http://old.example:8080'
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const activePartition = 'persist:orca-browser-session-pending'
    const retiredPartition = 'persist:orca-browser-session-restored'
    const active = fromPartition(activePartition)
    const retired = fromPartition(retiredPartition)
    const activeWrite = Promise.withResolvers<void>()
    const retiredWrite = Promise.withResolvers<void>()
    active.setProxy.mockReturnValueOnce(activeWrite.promise)
    retired.setProxy.mockReturnValueOnce(retiredWrite.promise)

    const activeSession = session.fromPartition(activePartition)
    const retiredSession = session.fromPartition(retiredPartition)
    const activeInstallation = applyProxyToBrowserSession(activeSession)
    const retiredInstallation = applyProxyToBrowserSession(retiredSession)
    try {
      await vi.waitFor(() => {
        expect(active.setProxy).toHaveBeenCalled()
        expect(retired.setProxy).toHaveBeenCalled()
      })
      invalidateBrowserSessionProxyApplication(retiredSession)
      const release = releaseProxySessionApplication(retiredSession)
      proxyUrl = 'http://new.example:8080'
      await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
      activeWrite.resolve()
      retiredWrite.resolve()
      await Promise.all([activeInstallation, retiredInstallation, release])

      const oldProxy = { mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }
      expect(active.setProxy.mock.calls).toEqual([
        [oldProxy],
        [{ mode: 'fixed_servers', proxyRules: 'http://new.example:8080' }]
      ])
      expect(retired.setProxy.mock.calls).toEqual([[oldProxy], [{ mode: 'system' }]])
    } finally {
      activeWrite.resolve()
      retiredWrite.resolve()
      await Promise.allSettled([activeInstallation, retiredInstallation])
    }
  })
})
