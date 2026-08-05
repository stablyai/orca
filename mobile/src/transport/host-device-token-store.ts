import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from './pairing-keychain'

const TOKEN_KEY_PREFIX = 'orca.host-token.'
const WEB_TOKEN_KEY_PREFIX = 'orca:web-host-token:'

export async function readHostDeviceToken(hostId: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(`${WEB_TOKEN_KEY_PREFIX}${hostId}`)
  }
  return readPairingKeychainItem(`${TOKEN_KEY_PREFIX}${hostId}`)
}

export async function writeHostDeviceToken(hostId: string, token: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(`${WEB_TOKEN_KEY_PREFIX}${hostId}`, token)
    return
  }
  await writePairingKeychainItem(`${TOKEN_KEY_PREFIX}${hostId}`, token)
}

export async function deleteHostDeviceToken(hostId: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(`${WEB_TOKEN_KEY_PREFIX}${hostId}`)
    return
  }
  await deletePairingKeychainItem(`${TOKEN_KEY_PREFIX}${hostId}`)
}
