import { app, session } from 'electron'
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import {
  applyProxySettingsToSession,
  setProxySessionOverride,
  getProxySessionApplicationReadiness
} from '../../../network/proxy-settings'
import { registerProxyNamespace } from '../api/proxy'
import {
  getBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import {
  observeBrowserExtensionProxySession,
  whenBrowserExtensionProxyReady
} from './browser-extension-proxy-session'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Proxy fixture requires background launch')
}
applyBackgroundActivationPolicy()
app.commandLine.appendSwitch('proxy-server', 'http://baseline.invalid:8999')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP direct.orca.test 127.0.0.1')

const servers: Server[] = []
async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing server address')
  }
  return address.port
}

async function extension(sess: Electron.Session, name: string): Promise<Electron.Extension> {
  const directory = join(app.getPath('userData'), name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name,
      version: '1.0',
      permissions: ['proxy']
    })
  )
  const loaded = await sess.extensions.loadExtension(directory)
  getBrowserExtensionInstallStore().save({
    id: loaded.id,
    name,
    version: '1.0',
    source: 'unpacked',
    path: directory,
    iconPath: null,
    permissions: ['proxy'],
    hostPermissions: [],
    optionsPage: null
  })
  return loaded
}

async function run(): Promise<void> {
  await app.whenReady()
  registerProxyNamespace()
  const portA = await listen(createServer((_req, res) => res.end('proxy-a')))
  const portB = await listen(createServer((_req, res) => res.end('proxy-b')))
  const pac = `function FindProxyForURL(url, host) {
    return host === 'direct.orca.test' ? 'DIRECT' : 'PROXY 127.0.0.1:${portB}';
  }`
  const originPort = await listen(
    createServer((req, res) => {
      res.setHeader(
        'Content-Type',
        req.url === '/proxy.pac' ? 'application/x-ns-proxy-autoconfig' : 'text/plain'
      )
      res.end(req.url === '/proxy.pac' ? pac : 'origin')
    })
  )
  const sess = session.fromPartition('persist:proxy-profile')
  const first = await extension(sess, 'first')
  const second = await extension(sess, 'second')
  observeBrowserExtensionProxySession(sess, 'proxy-profile', [first.id, second.id])
  const caller = (who: Electron.Extension): BrowserExtensionCaller => ({
    session: sess,
    browserProfileId: 'proxy-profile',
    extension: who,
    fromWorker: true
  })
  const invoke = async (who: Electron.Extension, method: string, details: unknown) => {
    const handler = getBrowserExtensionNamespace('proxy')?.methods[`settings.${method}`]
    if (!handler) {
      throw new Error('Missing proxy method')
    }
    return handler.invoke(caller(who), [details])
  }
  const set = (who: Electron.Extension, value: unknown) =>
    invoke(who, 'set', { value, scope: 'regular' })
  const body = async (url = 'http://proxied.orca.test/') =>
    (await sess.fetch(url, { cache: 'no-store' })).text()
  await whenBrowserExtensionProxyReady(sess)
  assert.equal(await sess.resolveProxy('http://proxied.orca.test/'), 'PROXY baseline.invalid:8999')
  await set(first, {
    mode: 'fixed_servers',
    rules: { singleProxy: { host: '127.0.0.1', port: portA } }
  })
  assert.equal(await body(), 'proxy-a')
  assert.deepEqual(await invoke(second, 'get', {}), {
    value: {
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: portA } }
    },
    levelOfControl: 'controllable_by_this_extension'
  })
  await set(second, {
    mode: 'fixed_servers',
    rules: {
      proxyForHttp: { host: '127.0.0.1', port: portA },
      fallbackProxy: { scheme: 'socks5', host: '::1', port: 1081 },
      bypassList: ['direct.orca.test']
    }
  })
  assert.equal(await body(`http://direct.orca.test:${originPort}/`), 'origin')
  assert.equal(await sess.resolveProxy('https://proxied.orca.test/'), 'SOCKS5 [::1]:1081')
  await set(second, { mode: 'pac_script', pacScript: { data: pac, url: '' } })
  assert.equal(await body(), 'proxy-b')
  assert.equal(await body(`http://direct.orca.test:${originPort}/`), 'origin')
  await set(first, { mode: 'direct' })
  assert.equal(await body(), 'proxy-b')
  const before = await invoke(second, 'get', {})
  await assert.rejects(
    set(second, {
      mode: 'pac_script',
      pacScript: { data: pac, url: 'https://invalid.test/proxy.pac' }
    }),
    /Specify PAC data or URL/
  )
  await assert.rejects(
    invoke(second, 'clear', { scope: 'incognito_session_only' }),
    /Invalid arguments/
  )
  assert.deepEqual(await invoke(second, 'get', {}), before)
  await set(second, {
    mode: 'pac_script',
    pacScript: { data: 'function broken(', mandatory: false }
  })
  await assert.rejects(body(), /ERR_MANDATORY_PROXY_CONFIGURATION_FAILED/)
  const failedPac = await invoke(second, 'get', {})
  assert.deepEqual(failedPac, {
    value: { mode: 'pac_script', pacScript: { data: 'function broken(', mandatory: true } },
    levelOfControl: 'controlled_by_this_extension'
  })
  await set(second, {
    mode: 'pac_script',
    pacScript: { url: `http://127.0.0.1:${originPort}/proxy.pac` }
  })
  assert.equal(await body(), 'proxy-b')
  await applyProxySettingsToSession(
    sess,
    { httpProxyUrl: `http://127.0.0.1:${portA}` },
    { env: {} }
  )
  assert.equal(await body(), 'proxy-b')
  const isolated = session.fromPartition('isolated-profile')
  await applyProxySettingsToSession(
    isolated,
    { httpProxyUrl: `http://127.0.0.1:${portA}` },
    { env: {} }
  )
  assert.equal(await (await isolated.fetch('http://proxied.orca.test/')).text(), 'proxy-a')
  let failure: 'none' | 'direct' | 'all' = 'direct'
  const faultable = {
    resolveProxy: (url: string) => isolated.resolveProxy(url),
    closeAllConnections: () => isolated.closeAllConnections(),
    setProxy: async (config: Electron.ProxyConfig) => {
      if (failure === 'all' || (failure === 'direct' && config.mode === 'direct')) {
        throw new Error('Injected proxy application failure')
      }
      await isolated.setProxy(config)
    }
  }
  await applyProxySettingsToSession(
    faultable,
    { httpProxyUrl: `http://127.0.0.1:${portA}` },
    { env: {} }
  )
  await assert.rejects(
    setProxySessionOverride(faultable, { mode: 'direct' }, { mode: 'system' }),
    /Injected proxy application failure/
  )
  assert.equal(await getProxySessionApplicationReadiness(faultable), true)
  assert.equal(await (await isolated.fetch('http://proxied.orca.test/')).text(), 'proxy-a')
  failure = 'all'
  await assert.rejects(
    setProxySessionOverride(faultable, { mode: 'direct' }, { mode: 'system' }),
    /Could not apply or restore/
  )
  assert.equal(await getProxySessionApplicationReadiness(faultable), false)
  await assert.rejects(
    applyProxySettingsToSession(faultable, {}, { env: {} }),
    /must be reapplied or cleared/
  )
  failure = 'none'
  await setProxySessionOverride(faultable, null, {
    mode: 'fixed_servers',
    proxyRules: `http://127.0.0.1:${portA}`
  })
  assert.equal(await getProxySessionApplicationReadiness(faultable), true)
  assert.equal(await (await isolated.fetch('http://proxied.orca.test/')).text(), 'proxy-a')
  sess.extensions.removeExtension(second.id)
  await whenBrowserExtensionProxyReady(sess)
  assert.equal(await sess.resolveProxy('http://proxied.orca.test/'), 'DIRECT')
  await invoke(first, 'clear', {})
  assert.equal(await body(), 'proxy-a')
  const restored = await sess.extensions.loadExtension(second.path)
  await whenBrowserExtensionProxyReady(sess)
  assert.equal(await body(), 'proxy-b')
  await invoke(restored, 'clear', {})
  assert.equal(await body(), 'proxy-a')
  await applyProxySettingsToSession(sess, {}, { env: {} })
  await set(first, { mode: 'direct' })
  await invoke(first, 'clear', {})
  assert.equal(await sess.resolveProxy('http://proxied.orca.test/'), 'PROXY baseline.invalid:8999')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nativeSetProxy = sess.setProxy.bind(sess)
  sess.setProxy = async (config) => {
    if (config.mode === 'direct') {
      entered.resolve()
      await release.promise
    }
    await nativeSetProxy(config)
  }
  const cancelled = assert.rejects(set(first, { mode: 'direct' }), /unloaded/)
  await entered.promise
  sess.extensions.removeExtension(first.id)
  getBrowserExtensionProfileStateStore().forgetProfileExtension('proxy-profile', first.id)
  release.resolve()
  await cancelled
  sess.setProxy = nativeSetProxy
  await whenBrowserExtensionProxyReady(sess)
  assert.equal(
    getBrowserExtensionProfileStateStore().readProfile('proxy-profile')[first.id],
    undefined
  )
  assert.equal(await sess.resolveProxy('http://proxied.orca.test/'), 'PROXY baseline.invalid:8999')
  getBrowserExtensionProfileStateStore().flush()
  console.log(
    JSON.stringify({
      routing: 'passed',
      pac: 'passed',
      lifecycle: 'passed',
      isolation: 'passed',
      baseline: 'passed'
    })
  )
}

void run().then(
  () => {
    for (const server of servers) {
      server.close()
    }
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
