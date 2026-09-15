import { Buffer } from 'node:buffer'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import { sha256 } from '@noble/hashes/sha256'
import * as zod from 'zod'
import {
  nativeStoreModule,
  partialNativeModule,
  silentNativeSubscription
} from './native-module-traps'
import { reactNativeScreenMembers, screenNativeSubstitutes } from './screen-native-substitutes'

/**
 * The native modules a mounted operation may import, and what it gets instead.
 *
 * The loader's default is a proxy that refuses any member of a non-relative import, which is what
 * keeps an adapter from silently mounting a device API. That default is too strict for the relay
 * pairing modules: each builds a `defaultDependencies` object at module scope, so merely
 * *referencing* `Platform.OS` or a storage-backed loader throws before an adapter can override it.
 *
 * So the table separates reference from use. `react` and `zod` are the real libraries — pure, and
 * React additionally has to be the one instance the test renderer drives, which is also why
 * `react/jsx-runtime` is the real module: the automatic runtime a screen compiles to must build
 * elements for that instance. `@noble/hashes` is the same pure-JS digest the product would run on a
 * device, and `expo-crypto` is routed through the Web Crypto the recording scheduler already pins,
 * which is both deterministic and what the library itself does off-device.
 *
 * Every substitute keeps one of the two trap shapes in `native-module-traps.ts`, which is where the
 * rule about unlisted members and `__esModule` lives. The view packages a mounted screen needs are
 * in `screen-native-substitutes.ts`, and the two entries a scenario can declare for itself — the
 * device store and the notification tray — are in `declared-device-state.ts`, absent here until a
 * recording declares them.
 *
 * `AppState`, `useWindowDimensions`, the two-way audio module and `expo-keep-awake` are the same
 * kind of boundary as the scripted socket: a screen-lock tag, a window size and a microphone are
 * inputs the recording pins rather than reads. Each is inert — no listener is ever fired and no
 * audio is produced — because every send the dictation and terminal hooks make is driven through
 * the operation's own API instead. A recording that needed a native event would have to say so by
 * adding an emitter here.
 */
export function nativeMountingSubstitutes(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['react', React],
    ['react/jsx-runtime', ReactJsxRuntime],
    ['zod', zod],
    ['@noble/hashes/sha256', partialNativeModule('@noble/hashes/sha256', { sha256 })],
    [
      'expo-crypto',
      partialNativeModule('expo-crypto', {
        getRandomBytes: (length: number) =>
          globalThis.crypto.getRandomValues(new Uint8Array(length))
      })
    ],
    // The RN polyfill mobile bundles is this same pure implementation of the same encoding.
    ['buffer', partialNativeModule('buffer', { Buffer })],
    // One pinned platform per recording; `platform` is golden provenance, not a compared field.
    [
      'react-native',
      partialNativeModule('react-native', {
        Platform: { OS: 'ios' },
        AppState: { currentState: 'active', addEventListener: silentNativeSubscription },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
        ...reactNativeScreenMembers()
      })
    ],
    [
      '@orca/expo-two-way-audio',
      partialNativeModule('@orca/expo-two-way-audio', {
        addExpoTwoWayAudioEventListener: silentNativeSubscription,
        initialize: () => Promise.resolve(true),
        requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
        tearDown: () => Promise.resolve(),
        toggleRecording: () => true
      })
    ],
    [
      'expo-keep-awake',
      partialNativeModule('expo-keep-awake', {
        activateKeepAwakeAsync: () => Promise.resolve(),
        deactivateKeepAwake: () => {}
      })
    ],
    ...screenNativeSubstitutes(),
    [
      '@react-native-async-storage/async-storage',
      nativeStoreModule('@react-native-async-storage/async-storage')
    ],
    ['expo-secure-store', nativeStoreModule('expo-secure-store')]
  ])
}
