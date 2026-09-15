import { Buffer } from 'node:buffer'
import * as React from 'react'
import { sha256 } from '@noble/hashes/sha256'
import * as zod from 'zod'

/**
 * The native modules a mounted operation may import, and what it gets instead.
 *
 * The loader's default is a proxy that throws on any property of a non-relative import, which is
 * what keeps an adapter from silently mounting a device API. That default is too strict for the
 * relay pairing modules: each builds a `defaultDependencies` object at module scope, so merely
 * *referencing* `Platform.OS` or a storage-backed loader throws before an adapter can override it.
 *
 * So the table separates reference from use. `react` and `zod` are the real libraries — pure, and
 * React additionally has to be the one instance the test renderer drives, and `@noble/hashes` is
 * the same pure-JS digest the product would run on a device. `expo-crypto` is routed through the
 * Web Crypto the recording scheduler already pins, which is both deterministic and what the library
 * itself does off-device.
 *
 * Every substitute that stands in for part of a module keeps the default's shape: a member nobody
 * listed throws on the read rather than resolving to `undefined`, because an undefined native
 * member is not a recording of anything — the product would call it. Async storage inverts that,
 * reading every member back as a function that throws when called: a default-dependency object may
 * name them, and a recording that reaches it fails at the call instead. Whether that failure is
 * visible depends on the caller. `host-app-version-store.ts` catches and degrades to its unread
 * state, which is what it does on a device too.
 *
 * Both traps leave `__esModule` undefined. It is the module system's interop marker rather than a
 * native API, and answering it truthfully binds a transpiled `import X from` to the trap's own
 * answer instead of the module object, leaving every consumer holding a member-less stand-in.
 *
 * `AppState`, `useWindowDimensions`, the two-way audio module and `expo-keep-awake` are the same
 * kind of boundary as the scripted socket: a screen-lock tag, a window size and a microphone are
 * inputs the recording pins rather than reads. Each is inert — no listener is ever fired and no
 * audio is produced — because every send the dictation and terminal hooks make is driven through
 * the operation's own API instead. A recording that needed a native event would have to say so by
 * adding an emitter here.
 */
function partialNativeModule(module: string, members: Record<string, unknown>): unknown {
  return new Proxy(members, {
    get: (target, key) => {
      if (typeof key === 'string') {
        if (key !== '__esModule' && !(key in target)) {
          throw new Error(`Unsubstituted native member: ${module}.${key}`)
        }
        return target[key]
      }
      return (target as Record<symbol, unknown>)[key]
    }
  })
}

/** A device event source with no events: registration succeeds, nothing is ever delivered. */
function silentNativeSubscription(): { remove: () => void } {
  return { remove: () => {} }
}

function unusableNativeStore(module: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === '__esModule') {
          return undefined
        }
        return (...args: unknown[]) => {
          void args
          throw new Error(`Native store reached during recording: ${module}.${String(key)}`)
        }
      }
    }
  )
}

export function nativeMountingSubstitutes(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['react', React],
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
        useWindowDimensions: () => ({ width: 390, height: 844 })
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
    [
      '@react-native-async-storage/async-storage',
      unusableNativeStore('@react-native-async-storage/async-storage')
    ],
    ['expo-secure-store', unusableNativeStore('expo-secure-store')]
  ])
}
