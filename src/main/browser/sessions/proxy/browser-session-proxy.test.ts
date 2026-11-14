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

  it('settles an in-flight new partition on the latest swept policy', async () => {
    let proxyUrl = 'http://old.example:8080'
    let finishFirstWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const sess = fromPartition('persist:orca-browser-session-pending')
    sess.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    )

    const pendingInstallation = applyProxyToBrowserSession(sess as never)
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    proxyUrl = 'http://new.example:8080'
    await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
    finishFirstWrite?.()
    await pendingInstallation

    expect(sess.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }],
      [{ mode: 'fixed_servers', proxyRules: 'http://new.example:8080' }]
    ])
  })

  it('does not reapply policy after an in-flight partition is invalidated', async () => {
    let proxyUrl = 'http://old.example:8080'
    let finishFirstWrite: (() => void) | undefined
    setBrowserNetworkProxySettingsResolver(() => ({ httpProxyUrl: proxyUrl }))
    const sess = fromPartition('persist:orca-browser-session-restored')
    sess.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstWrite = resolve))
    )

    const restoredInstallation = applyProxyToBrowserSession(sess as never)
    await vi.waitFor(() => expect(sess.setProxy).toHaveBeenCalledTimes(1))
    invalidateBrowserSessionProxyApplication(sess as never)
    const release = releaseProxySessionApplication(sess as never)
    proxyUrl = 'http://new.example:8080'
    await applyBrowserSessionProxies([], { httpProxyUrl: proxyUrl })
    finishFirstWrite?.()
    await Promise.all([restoredInstallation, release])

    expect(sess.setProxy.mock.calls).toEqual([
      [{ mode: 'fixed_servers', proxyRules: 'http://old.example:8080' }],
      [{ mode: 'system' }]
    ])
  })
})
