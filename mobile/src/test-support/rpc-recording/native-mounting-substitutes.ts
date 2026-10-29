import { Buffer } from 'node:buffer'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import { sha256 } from '@noble/hashes/sha256'
import * as i18next from 'i18next'
import * as lowlight from 'lowlight'
import * as zod from 'zod'
import {
  nativeStoreModule,
  partialNativeModule,
  silentNativeSubscription
} from './native-module-traps'
import { reactNativeScreenMembers, screenNativeSubstitutes } from './screen-native-substitutes'

// Substitute native boundaries while retaining real pure libraries and the renderer’s React instance.
// Keep default-dependency references loadable, but trap undeclared native use (native-module-traps.ts).
// Inputs are pinned and listeners/audio inert; new native events need explicit emitters.
// Haptics list only iOS members; platform coverage is pinned to iOS.
// Clipboard is per-recording state; its reads return only bytes written by that recording.
/** The system pasteboard as a per-recording cell: empty at mount, readable after a write. */
function pasteboardNativeStore(): unknown {
  let text: string | null = null
  return partialNativeModule('expo-clipboard', {
    getStringAsync: () => Promise.resolve(text ?? ''),
    hasStringAsync: () => Promise.resolve(text !== null),
    hasImageAsync: () => Promise.resolve(false),
    setStringAsync: (value: string) => {
      text = value
      return Promise.resolve(true)
    }
  })
}

export function nativeMountingSubstitutes(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['react', React],
    ['react/jsx-runtime', ReactJsxRuntime],
    ['zod', zod],
    // Use real highlighting so preview tokens come from product behavior.
    ['lowlight', lowlight],
    // Real catalogs and plural rules; recordings run in English, the device language below.
    ['i18next', i18next],
    [
      'expo-localization',
      partialNativeModule('expo-localization', {
        getLocales: () => [{ languageTag: 'en-US' }],
        useLocales: () => [{ languageTag: 'en-US' }]
      })
    ],
    ['@noble/hashes/sha256', partialNativeModule('@noble/hashes/sha256', { sha256 })],
    [
      'expo-crypto',
      partialNativeModule('expo-crypto', {
        getRandomBytes: (length: number) =>
          globalThis.crypto.getRandomValues(new Uint8Array(length)),
        // Hashed before it resolves, as the native module's synchronous digest is.
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digest: async (_algorithm: string, data: Uint8Array) => sha256(data).buffer
      })
    ],
    // The RN polyfill mobile bundles is this same pure implementation of the same encoding.
    ['buffer', partialNativeModule('buffer', { Buffer })],
    [
      'react-native',
      partialNativeModule('react-native', {
        Platform: { OS: 'ios' },
        AppState: { currentState: 'active', addEventListener: silentNativeSubscription },
        BackHandler: { addEventListener: silentNativeSubscription },
        Keyboard: { dismiss: () => {} },
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
      'expo-haptics',
      partialNativeModule('expo-haptics', {
        impactAsync: () => Promise.resolve(),
        notificationAsync: () => Promise.resolve(),
        selectionAsync: () => Promise.resolve(),
        ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
        NotificationFeedbackType: { Error: 'error', Success: 'success' }
      })
    ],
    ['expo-clipboard', pasteboardNativeStore()],
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
