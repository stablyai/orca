import { NativeModules } from 'react-native'
import { OrcaGzipUtf8Codec } from '../../modules/orca-gzip-utf8-codec/src'
import type { LibsodiumBindings, PairedE2EENativeBindings } from './paired-e2ee-native-codec'

declare global {
  // Installed by react-native-libsodium's native install; unknown until checked.
  var jsi_from_base64_to_arraybuffer: unknown
  var jsi_crypto_secretbox_open_easy: unknown
}

/**
 * Null when either native piece is missing from this binary. Only the app entry imports this file:
 * shared, desktop and e2e code reach the transport modules and must not load native-module types.
 */
export function loadPairedE2EENativeBindings(): PairedE2EENativeBindings | null {
  const sodium = installLibsodium()
  return sodium && OrcaGzipUtf8Codec ? { codec: OrcaGzipUtf8Codec, sodium } : null
}

/**
 * react-native-libsodium's JS entry installs its JSI functions on import, logs as it does, and
 * wraps every call; only its native install and two of the functions are needed here.
 */
function installLibsodium(): LibsodiumBindings | null {
  const libsodium: { install?: unknown } | undefined = NativeModules.Libsodium
  if (typeof libsodium?.install !== 'function') {
    return null
  }
  libsodium.install()
  const fromBase64 = globalThis.jsi_from_base64_to_arraybuffer
  const secretboxOpen = globalThis.jsi_crypto_secretbox_open_easy
  if (typeof fromBase64 !== 'function' || typeof secretboxOpen !== 'function') {
    return null
  }
  return {
    fromBase64: (value, variant) => arrayBufferOf(fromBase64(value, variant)),
    secretboxOpen: (box, nonce, key) => arrayBufferOf(secretboxOpen(box, nonce, key))
  }
}

function arrayBufferOf(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new TypeError('libsodium returned something other than an ArrayBuffer')
  }
  return value
}
