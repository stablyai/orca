import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'orca:last-pairing-code'

// Why: a failed pairing should not force the user to re-scan the QR code;
// the last attempted code is offered again until one succeeds.
export function rememberPairingCode(raw: string): Promise<void> {
  return AsyncStorage.setItem(STORAGE_KEY, raw.trim())
}

export function clearRecalledPairingCode(): Promise<void> {
  return AsyncStorage.removeItem(STORAGE_KEY)
}

export function loadRecalledPairingCode(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEY)
}
