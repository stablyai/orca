import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from './pairing-keychain'

// Why: SecureStore keys must match [A-Za-z0-9._-] (colons rejected), so use dots as the separator.
const TOKEN_KEY_PREFIX = 'orca.host-token.'
const WEB_TOKEN_KEY_PREFIX = 'orca:web-host-token:'

function tokenKey(hostId: string): string {
  return `${TOKEN_KEY_PREFIX}${hostId}`
}

function webTokenKey(hostId: string): string {
  return `${WEB_TOKEN_KEY_PREFIX}${hostId}`
}

export async function readHostDeviceToken(hostId: string): Promise<string | null> {
  // Why: Expo SecureStore has no working web backend; fall back to AsyncStorage only on web so native still uses the keychain.
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(webTokenKey(hostId))
  }
  return readPairingKeychainItem(tokenKey(hostId))
}

export async function writeHostDeviceToken(hostId: string, token: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(webTokenKey(hostId), token)
    return
  }
  await writePairingKeychainItem(tokenKey(hostId), token)
}

export async function deleteHostDeviceToken(hostId: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(webTokenKey(hostId))
    return
  }
  await deletePairingKeychainItem(tokenKey(hostId))
}
