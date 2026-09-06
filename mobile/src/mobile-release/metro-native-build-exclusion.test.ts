import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../../metro.config.js')
const blocked = (file: string): boolean =>
  config.resolver.blockList.some((pattern: RegExp) => pattern.test(file))

describe('Metro native build exclusions', () => {
  it.each([
    'ReactAndroid/build/third-party-ndk/boost/header.hpp',
    'ReactAndroid/.cxx/Debug/arm64-v8a/build.ninja',
    'ReactAndroid/hermes-engine/build/hermes/bin/hermesc',
    'ReactAndroid/hermes-engine/.cxx/Release/build.ninja',
    'sdks/hermes/external/flowtest/test.js'
  ])('excludes generated native input %s on every host', (suffix) => {
    const file = `/workspace/node_modules/.pnpm/react-native/node_modules/react-native/${suffix}`
    expect(blocked(file)).toBe(true)
    expect(blocked(file.replaceAll('/', '\\'))).toBe(true)
  })

  it.each([
    '/workspace/mobile/src/session/use-session.ts',
    '/workspace/src/shared/protocol-version.ts',
    '/workspace/node_modules/react-native/Libraries/Components/TextInput/TextInput.js',
    '/workspace/node_modules/react-native/ReactAndroid/src/main/java/TextInput.kt',
    '/workspace/node_modules/react-native/sdks/hermesc/version.txt',
    '/workspace/node_modules/react-native/sdks/hermes-custom/input.js'
  ])('keeps source and similarly named paths visible: %s', (file) => {
    expect(blocked(file)).toBe(false)
    expect(blocked(file.replaceAll('/', '\\'))).toBe(false)
  })

  it('retains Expo default exclusions', () => {
    expect(blocked('/workspace/.expo/types/router.d.ts')).toBe(true)
  })
})
