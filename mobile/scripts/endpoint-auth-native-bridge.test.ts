import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { updateAndroidSettingsGradle } from 'expo-build-properties/build/android'
import { describe, expect, it, vi } from 'vitest'
import appConfig from '../app.json'

const requireNative = createRequire(import.meta.resolve('react-native/package.json'))

function nativeSocketConstructor(
  connect: ReturnType<typeof vi.fn>,
  capabilities: { supportsNoRedirects: boolean } | null = { supportsNoRedirects: true }
) {
  const babel: unknown = requireNative('@babel/core')
  if (
    !babel ||
    typeof babel !== 'object' ||
    !('transformSync' in babel) ||
    typeof babel.transformSync !== 'function'
  ) {
    throw new Error('React Native Babel transform unavailable')
  }
  const source = readFileSync(requireNative.resolve('./Libraries/WebSocket/WebSocket.js'), 'utf8')
  const transformed: unknown = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [
      requireNative.resolve('@babel/plugin-transform-flow-strip-types'),
      requireNative.resolve('@babel/plugin-transform-modules-commonjs')
    ]
  })
  if (
    !transformed ||
    typeof transformed !== 'object' ||
    !('code' in transformed) ||
    typeof transformed.code !== 'string'
  ) {
    throw new Error('React Native WebSocket transform failed')
  }
  const module = { exports: {} }
  runInNewContext(transformed.code, {
    module,
    exports: module.exports,
    console,
    require: (name: string) => {
      if (name.endsWith('/NativeWebSocketModule')) {
        return capabilities ? { connect, getConstants: () => capabilities } : { connect }
      }
      if (name.endsWith('/Platform')) {
        return { OS: 'android' }
      }
      if (name.endsWith('/EventTarget')) {
        return EventTarget
      }
      if (name.endsWith('/EventHandlerAttributes')) {
        return { getEventHandlerAttribute: () => null, setEventHandlerAttribute: () => {} }
      }
      if (name.endsWith('/NativeEventEmitter')) {
        return class {
          addListener() {
            return { remove() {} }
          }
        }
      }
      if (
        name.endsWith('/Event') ||
        name.endsWith('/MessageEvent') ||
        name.endsWith('/CloseEvent')
      ) {
        return Event
      }
      if (name.endsWith('/Blob')) {
        return Blob
      }
      if (name.endsWith('/BlobManager') || name === 'base64-js') {
        return {}
      }
      if (name.endsWith('/binaryToBase64') || name === 'invariant') {
        return () => {}
      }
      throw new Error(`Unexpected native dependency: ${name}`)
    }
  })
  const exported: unknown = module.exports
  const Constructor =
    exported && typeof exported === 'object' && 'default' in exported ? exported.default : exported
  if (typeof Constructor !== 'function') {
    throw new Error('Native socket constructor not exported')
  }
  return Constructor
}

describe('credential socket native bridge', () => {
  it('resolves native source paths without Prefab option delimiters', () => {
    const source = realpathSync(requireNative.resolve('./ReactAndroid/build.gradle.kts'))
    expect(source).not.toContain('=')
  })

  it.each([null, { supportsNoRedirects: false }])(
    'refuses credentials on an unsupported Android build (%j)',
    (capabilities) => {
      const connect = vi.fn()
      const Constructor = nativeSocketConstructor(connect, capabilities)
      expect(() =>
        Reflect.construct(Constructor, [
          'wss://tunnel.example',
          undefined,
          { headers: { 'CF-Access-Client-Secret': 'synthetic-secret' }, followRedirects: false }
        ])
      ).toThrow('Update the Orca app to use edge authentication')
      expect(connect).not.toHaveBeenCalled()
    }
  )

  it('builds Android from the patched native source instead of the prebuilt library', () => {
    const plugin = appConfig.expo.plugins.find(
      (entry) => Array.isArray(entry) && entry[0] === 'expo-build-properties'
    )
    if (
      !Array.isArray(plugin) ||
      !plugin[1] ||
      typeof plugin[1] !== 'object' ||
      !('android' in plugin[1])
    ) {
      throw new Error('Android build properties unavailable')
    }
    const settings = updateAndroidSettingsGradle({
      contents: 'rootProject.name = "Orca"\n',
      buildFromSource: plugin[1].android.buildReactNativeFromSource
    })
    expect(settings).toContain('includeBuild(expoAutolinking.reactNative)')
    expect(settings).toContain(
      'substitute(module("com.facebook.react:react-android")).using(project(":packages:react-native:ReactAndroid"))'
    )
  })

  it('passes the no-redirect policy through the installed React Native constructor', () => {
    const connect = vi.fn()
    const Constructor = nativeSocketConstructor(connect)
    const headers = { 'CF-Access-Client-Secret': 'synthetic-secret' }
    Reflect.construct(Constructor, [
      'wss://tunnel.example',
      undefined,
      { headers, followRedirects: false }
    ])
    expect(connect.mock.calls[0]?.[2]).toEqual({ headers, followRedirects: false })
  })

  it('retains the native options for ordinary sockets', () => {
    const connect = vi.fn()
    Reflect.construct(nativeSocketConstructor(connect, null), ['wss://tunnel.example'])
    expect(connect.mock.calls[0]?.[2]).toEqual({ headers: {} })
  })
})
