import { describe, expect, it } from 'vitest'
import {
  prepareBrowserRouteSessionPolicy,
  type BrowserRouteElectronSession,
  type BrowserRouteViewer
} from './browser-route-session-policy'

const SOCKS = 'SOCKS5 127.0.0.1:4100'

// Chromium's answers for the two probes under each rule string, as Electron 41 resolves them
// (loopback is proxied unless bypassed; `*` sends the rest direct).
function session(): BrowserRouteElectronSession & { rules: string[] } {
  const rules: string[] = []
  return {
    rules,
    setProxy: async (config) => void rules.push(config.proxyBypassRules),
    closeAllConnections: async () => {},
    resolveProxy: async (url) =>
      new URL(url).hostname === '127.0.0.1' || !rules.at(-1)?.startsWith('*') ? SOCKS : 'DIRECT'
  }
}

async function prepare(viewer: BrowserRouteViewer | undefined) {
  const routed = session()
  await prepareBrowserRouteSessionPolicy({
    partition: 'persist:p',
    browserProfileId: 'default',
    proxyEndpoint: { host: '127.0.0.1', port: 4100 },
    ...(viewer ? { viewer } : {}),
    dependencies: {
      getSession: () => routed,
      setupPolicies: () => {},
      clearPolicies: () => {}
    }
  })
  return routed.rules
}

describe('what a client-hosted page sends through its host', () => {
  it('sends everything through one of your own computers, as before', async () => {
    expect(await prepare(undefined)).toEqual(['<-loopback>'])
    expect(await prepare('own-computer')).toEqual(['<-loopback>'])
  })

  it('sends only loopback through a teammate’s host, the rest direct from this machine', async () => {
    expect(await prepare('teammate')).toEqual(['*,<-loopback>,169.254.0.0/16,fe80::/10'])
  })
})
