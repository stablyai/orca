import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { SecureStoreLatestValueCoordinator } from './secure-store-latest-value-coordinator'

// Why: SecureStore keys must match [A-Za-z0-9._-]; colons are rejected.
const TOKEN_KEY_PREFIX = 'orca.host-token.'
const WEB_TOKEN_KEY_PREFIX = 'orca:web-host-token:'

// Why: this keeps the pairing token off cross-device Keychain sync and backups
// while allowing silent reads without a biometric access-control prompt.
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

function tokenKey(hostId: string): string {
  return `${TOKEN_KEY_PREFIX}${hostId}`
}

function webTokenKey(hostId: string): string {
  return `${WEB_TOKEN_KEY_PREFIX}${hostId}`
}

const tokenWrites = new SecureStoreLatestValueCoordinator(async (hostId, desired) => {
  if (Platform.OS === 'web') {
    if (desired) {
      await AsyncStorage.setItem(webTokenKey(hostId), desired.value)
    } else {
      await AsyncStorage.removeItem(webTokenKey(hostId))
    }
    return
  }
  if (desired) {
    await SecureStore.setItemAsync(tokenKey(hostId), desired.value, KEYCHAIN_OPTIONS)
  } else {
    await SecureStore.deleteItemAsync(tokenKey(hostId), KEYCHAIN_OPTIONS)
  }
})

export async function readHostDeviceToken(hostId: string): Promise<string | null> {
  const pending = tokenWrites.pending(hostId)
  if (pending.present) {
    return pending.value
  }
  // Why: Expo SecureStore has no working web backend; keep this fallback
  // web-only so native builds still keep pairing tokens in the keychain.
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(webTokenKey(hostId))
  }
  return SecureStore.getItemAsync(tokenKey(hostId), KEYCHAIN_OPTIONS)
}

export function writeHostDeviceToken(
  hostId: string,
  token: string,
  replace: boolean
): Promise<void> {
  return replace ? tokenWrites.replace(hostId, token) : tokenWrites.write(hostId, token)
}

export function deleteHostDeviceToken(hostId: string): Promise<void> {
  return tokenWrites.delete(hostId)
}

export function isHostDeviceTokenTombstoned(hostId: string): boolean {
  return tokenWrites.isTombstoned(hostId)
}

/** Test-only: clear pending generations between cases. */
export function resetHostDeviceTokenStoreForTests(): void {
  tokenWrites.resetForTests()
}
