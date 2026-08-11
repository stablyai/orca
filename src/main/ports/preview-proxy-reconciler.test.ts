import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desiredPreviewConfigFromSettings,
  PreviewProxyReconciler
} from './preview-proxy-reconciler'
import { setActivePreviewProxyConfig, getActivePreviewProxyConfig } from './worktree-preview-routes'

const reconcilers: PreviewProxyReconciler[] = []

function makeReconciler(): PreviewProxyReconciler {
  const reconciler = new PreviewProxyReconciler({ resolveRoutes: async () => new Map() })
  reconcilers.push(reconciler)
  return reconciler
}

afterEach(async () => {
  while (reconcilers.length > 0) {
    await reconcilers.pop()?.stop()
  }
  setActivePreviewProxyConfig(null)
})

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('no port'))
        }
      })
    })
  })
}

describe('desiredPreviewConfigFromSettings', () => {
  it('returns null when disabled or incomplete', () => {
    expect(desiredPreviewConfigFromSettings({})).toBeNull()
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: { enabled: false, port: 6769, domain: 'preview.test' }
      })
    ).toBeNull()
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: { enabled: true, port: 0, domain: 'preview.test' }
      })
    ).toBeNull()
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: { enabled: true, port: 6769, domain: '   ' }
      })
    ).toBeNull()
  })

  it('defaults bind to loopback with open auth, and token auth on wide binds', () => {
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: { enabled: true, port: 6769, domain: 'preview.test' }
      })
    ).toEqual({
      port: 6769,
      bindHost: '127.0.0.1',
      domain: 'preview.test',
      auth: 'open',
      token: null
    })
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: { enabled: true, port: 6769, domain: 'preview.test', bindHost: '0.0.0.0' }
      })?.auth
    ).toBe('token')
  })

  it('honors explicit auth and trims the token', () => {
    expect(
      desiredPreviewConfigFromSettings({
        previewProxy: {
          enabled: true,
          port: 6769,
          domain: 'preview.test',
          auth: 'token',
          token: ' secret '
        }
      })
    ).toMatchObject({ auth: 'token', token: 'secret' })
  })
})

describe('PreviewProxyReconciler', () => {
  it('starts from flags config and publishes the active config', async () => {
    const reconciler = makeReconciler()
    await reconciler.setFlagsConfig({
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'https://preview.test',
      auth: 'open',
      token: null
    })
    const status = reconciler.status()
    expect(status).toMatchObject({
      running: true,
      source: 'flags',
      origin: 'https://*.preview.test',
      auth: 'open'
    })
    expect(status.port).toBeGreaterThan(0)
    expect(getActivePreviewProxyConfig()?.origin.host).toBe('preview.test')
  })

  it('generates one stable token when token auth has none configured', async () => {
    const reconciler = makeReconciler()
    const config = {
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'preview.test',
      auth: 'token' as const,
      token: null
    }
    await reconciler.setFlagsConfig(config)
    const first = reconciler.status().token
    expect(first).toBeTruthy()
    // A restart with different config must keep the generated token stable.
    await reconciler.setFlagsConfig({ ...config, domain: 'other.test' })
    expect(reconciler.status().token).toBe(first)
  })

  it('falls back from flags to settings config and stops when both clear', async () => {
    const reconciler = makeReconciler()
    const settingsPort = await freeLocalPort()
    await reconciler.applySettings({
      previewProxy: { enabled: true, port: settingsPort, domain: 'settings.test' }
    })
    expect(reconciler.status()).toMatchObject({ running: true, source: 'settings' })

    await reconciler.setFlagsConfig({
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'flags.test',
      auth: 'open',
      token: null
    })
    expect(reconciler.status()).toMatchObject({
      running: true,
      source: 'flags',
      origin: 'https://*.flags.test'
    })

    await reconciler.setFlagsConfig(null)
    expect(reconciler.status()).toMatchObject({
      running: true,
      source: 'settings',
      origin: 'https://*.settings.test'
    })

    await reconciler.applySettings({})
    expect(reconciler.status()).toMatchObject({ running: false, source: null })
    expect(getActivePreviewProxyConfig()).toBeNull()
  })

  it('reports an invalid domain as status instead of throwing', async () => {
    const reconciler = makeReconciler()
    await reconciler.setFlagsConfig({
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'preview.test/path',
      auth: 'open',
      token: null
    })
    const status = reconciler.status()
    expect(status.running).toBe(false)
    expect(status.error).toContain('path')
    expect(getActivePreviewProxyConfig()).toBeNull()
  })

  it('reports a token outside the cookie-safe alphabet as status instead of binding', async () => {
    const reconciler = makeReconciler()
    await reconciler.applySettings({
      previewProxy: {
        enabled: true,
        port: await freeLocalPort(),
        domain: 'preview.test',
        auth: 'token',
        // Persisted before validation existed: `;` ends a cookie value.
        token: 'sec;ret'
      }
    })
    const status = reconciler.status()
    expect(status.running).toBe(false)
    expect(status.error).toContain('token')
    expect(getActivePreviewProxyConfig()).toBeNull()
  })

  it('reports a bind failure as status and recovers on the next valid config', async () => {
    const reconciler = makeReconciler()
    await reconciler.setFlagsConfig({
      port: 0,
      // TEST-NET-3 address: never assigned locally, so listen() fails fast.
      bindHost: '203.0.113.1',
      domain: 'preview.test',
      auth: 'open',
      token: null
    })
    expect(reconciler.status().running).toBe(false)
    expect(reconciler.status().error).toBeTruthy()

    await reconciler.setFlagsConfig({
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'preview.test',
      auth: 'open',
      token: null
    })
    expect(reconciler.status().running).toBe(true)
    expect(reconciler.status().error).toBeUndefined()
  })

  it('does not restart when the applied config is unchanged', async () => {
    const reconciler = makeReconciler()
    const config = {
      port: 0,
      bindHost: '127.0.0.1',
      domain: 'preview.test',
      auth: 'open' as const,
      token: null
    }
    await reconciler.setFlagsConfig(config)
    const firstPort = reconciler.status().port
    await reconciler.setFlagsConfig({ ...config })
    // An unchanged config keeps the same listener (an ephemeral rebind would change the port).
    expect(reconciler.status().port).toBe(firstPort)
  })
})
