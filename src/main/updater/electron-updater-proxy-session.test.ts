import { describe, expect, it, vi } from 'vitest'
import { NET_SESSION_NAME } from 'electron-updater/out/electronHttpExecutor'

const { fromPartitionMock, updaterSession } = vi.hoisted(() => {
  const updaterSession = {
    setProxy: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => 'DIRECT'),
    closeAllConnections: vi.fn(async () => {}),
    webRequest: { onBeforeRequest: vi.fn() }
  }
  return { fromPartitionMock: vi.fn(() => updaterSession), updaterSession }
})

vi.mock('electron', () => ({ session: { fromPartition: fromPartitionMock } }))

import {
  applyProxyToElectronUpdaterSession,
  handleElectronUpdaterProxyLogin
} from './electron-updater-proxy-session'

describe('electron-updater proxy session', () => {
  it('applies the app proxy and its credentials to the session electron-updater requests use', async () => {
    await applyProxyToElectronUpdaterSession({
      httpProxyUrl: 'http://user:secret@proxy.example:8080',
      httpProxyBypassRules: ''
    })

    expect(fromPartitionMock).toHaveBeenCalledWith(NET_SESSION_NAME, { cache: false })
    expect(updaterSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    expect(updaterSession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example:8080'
    })
    const callback = vi.fn()
    handleElectronUpdaterProxyLogin(
      { isProxy: true, host: 'proxy.example', port: 8080, scheme: 'basic', realm: '' },
      callback
    )
    expect(callback).toHaveBeenCalledWith('user', 'secret')
  })
})
