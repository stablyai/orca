import { app, session, type ProxyConfig } from 'electron'
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import {
  browserExtensionProxyConfigSchema,
  fromElectronProxyConfig,
  toElectronProxyConfig
} from './browser-extension-proxy-config'

import {
  observeBrowserExtensionProxySession,
  whenBrowserExtensionProxyReady,
  getBrowserExtensionProxySetting,
  changeBrowserExtensionProxySetting
} from './browser-extension-proxy-session'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Proxy fixture requires background launch')
}
applyBackgroundActivationPolicy()

async function run(): Promise<void> {
  await app.whenReady()
  const sess = session.fromPartition('persist:proxy-native-readback')
  const urls = ['http://example.test/', 'https://example.test/', 'wss://example.test/']
  const resolve = () => Promise.all(urls.map((url) => sess.resolveProxy(url)))
  const spaced: ProxyConfig = {
    mode: 'fixed_servers',
    proxyRules: ' http \t = proxy.example:8080 ; https = socks://127.0.0.1:1080 '
  }
  await sess.setProxy(spaced)
  assert.deepEqual(await resolve(), [
    'PROXY proxy.example:8080',
    'SOCKS5 127.0.0.1:1080',
    'SOCKS5 127.0.0.1:1080'
  ])
  const readback = fromElectronProxyConfig(spaced)
  assert.deepEqual(readback, {
    mode: 'fixed_servers',
    rules: {
      proxyForHttp: { scheme: 'http', host: 'proxy.example', port: 8080 },
      proxyForHttps: { scheme: 'socks5', host: '127.0.0.1', port: 1080 }
    }
  })
  await sess.setProxy(toElectronProxyConfig(browserExtensionProxyConfigSchema.parse(readback)))
  assert.deepEqual(await resolve(), [
    'PROXY proxy.example:8080',
    'SOCKS5 127.0.0.1:1080',
    'SOCKS5 127.0.0.1:1080'
  ])
  for (const [proxyRules, expected] of [
    [
      'direct://,proxy.example:8080',
      [
        'DIRECT;PROXY proxy.example:8080',
        'DIRECT;PROXY proxy.example:8080',
        'DIRECT;PROXY proxy.example:8080'
      ]
    ],
    [
      'http=direct://,proxy.example:8080',
      ['DIRECT;PROXY proxy.example:8080', 'DIRECT', 'DIRECT;PROXY proxy.example:8080']
    ],
    [
      'http=direct://;http=proxy.example:8080',
      ['DIRECT;PROXY proxy.example:8080', 'DIRECT', 'DIRECT;PROXY proxy.example:8080']
    ],
    [
      'http=direct://;socks=socks://127.0.0.1:1080',
      ['DIRECT', 'SOCKS5 127.0.0.1:1080', 'SOCKS5 127.0.0.1:1080']
    ],
    ['http=proxy.example:8080;https=direct://', ['PROXY proxy.example:8080', 'DIRECT', 'DIRECT']]
  ] as const) {
    const config: ProxyConfig = { mode: 'fixed_servers', proxyRules }
    await sess.setProxy(config)
    assert.deepEqual(await resolve(), expected)
    assert.throws(() => fromElectronProxyConfig(config), /DIRECT.*cannot be represented/)
    assert.deepEqual(await resolve(), expected)
    await sess.setProxy({ mode: 'direct' })
    assert.deepEqual(await resolve(), ['DIRECT', 'DIRECT', 'DIRECT'])
  }
  for (const [proxyRules, expected] of [
    ['direct://,DIRECT://', 'DIRECT;DIRECT'],
    ['http=direct://;socks=direct://', 'DIRECT']
  ] as const) {
    const config: ProxyConfig = { mode: 'fixed_servers', proxyRules }
    await sess.setProxy(config)
    assert.deepEqual(await resolve(), [expected, expected, expected])
    assert.deepEqual(fromElectronProxyConfig(config), { mode: 'direct' })
  }
  const httpSetting = {
    mode: 'fixed_servers',
    rules: { proxyForHttp: { scheme: 'http', host: 'first.invalid', port: 8080 } }
  }
  const singleSetting = {
    mode: 'fixed_servers',
    rules: { singleProxy: { scheme: 'http', host: 'first.invalid', port: 8080 } }
  }
  for (const [proxyRules, expected, setting, projected] of [
    [
      'http=first.invalid:8080;http=second.invalid:8081',
      [
        'PROXY first.invalid:8080;PROXY second.invalid:8081',
        'DIRECT',
        'PROXY first.invalid:8080;PROXY second.invalid:8081'
      ],
      httpSetting,
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080']
    ],
    [
      'http=first.invalid:8080;http=direct://',
      ['PROXY first.invalid:8080;DIRECT', 'DIRECT', 'PROXY first.invalid:8080;DIRECT'],
      httpSetting,
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080']
    ],
    [
      'http=first.invalid:8080;stray.invalid:8082',
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080'],
      httpSetting,
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080']
    ],
    [
      'unknown=ignored.invalid:8888;http=first.invalid:8080',
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080'],
      httpSetting,
      ['PROXY first.invalid:8080', 'DIRECT', 'PROXY first.invalid:8080']
    ],
    [
      'first.invalid:8080;http=second.invalid:8081',
      ['PROXY first.invalid:8080', 'PROXY first.invalid:8080', 'PROXY first.invalid:8080'],
      singleSetting,
      ['PROXY first.invalid:8080', 'PROXY first.invalid:8080', 'PROXY first.invalid:8080']
    ]
  ] as const) {
    const config: ProxyConfig = { mode: 'fixed_servers', proxyRules }
    await sess.setProxy(config)
    assert.deepEqual(await resolve(), expected, proxyRules)
    const value = fromElectronProxyConfig(config)
    assert.deepEqual(value, setting, proxyRules)
    await sess.setProxy(toElectronProxyConfig(browserExtensionProxyConfigSchema.parse(value)))
    assert.deepEqual(await resolve(), projected, proxyRules)
  }
  const nativeRules = 'http=direct://;socks=socks://127.0.0.1:1080'
  app.commandLine.appendSwitch('proxy-server', nativeRules)
  await sess.setProxy({ mode: 'fixed_servers', proxyRules: nativeRules })
  const directory = join(app.getPath('userData'), 'native-readback-extension')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Native readback',
      version: '1.0',
      permissions: ['proxy']
    })
  )
  const extension = await sess.extensions.loadExtension(directory)
  observeBrowserExtensionProxySession(sess, 'native-readback', [extension.id])
  await whenBrowserExtensionProxyReady(sess)
  await assert.rejects(
    getBrowserExtensionProxySetting(sess, extension.id),
    /DIRECT.*cannot be represented/
  )
  await changeBrowserExtensionProxySetting(sess, extension.id, { mode: 'direct' })
  assert.deepEqual(await resolve(), ['DIRECT', 'DIRECT', 'DIRECT'])
  await changeBrowserExtensionProxySetting(sess, extension.id, undefined)
  assert.deepEqual(await resolve(), ['DIRECT', 'SOCKS5 127.0.0.1:1080', 'SOCKS5 127.0.0.1:1080'])
  await assert.rejects(
    getBrowserExtensionProxySetting(sess, extension.id),
    /DIRECT.*cannot be represented/
  )
}

void run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
