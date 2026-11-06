import AsyncStorage from '@react-native-async-storage/async-storage'
import { getIpAddressAsync, getNetworkStateAsync, NetworkStateType } from 'expo-network'

export type HostGoodPath = 'direct' | 'relay'

type HostPathRecord = { path: HostGoodPath; fingerprint: string }

const STORAGE_KEY_PREFIX = 'orca:host-path:v1:'

// True only when this host's last good connection was direct on the network the phone is on now.
export async function lastGoodPathWasDirectHere(hostId: string): Promise<boolean> {
  try {
    const [stored, fingerprint] = await Promise.all([
      AsyncStorage.getItem(storageKey(hostId)),
      readNetworkFingerprint()
    ])
    const record = parseRecord(stored)
    return record?.path === 'direct' && record.fingerprint === fingerprint
  } catch {
    return false
  }
}

export async function recordHostGoodPath(hostId: string, path: HostGoodPath): Promise<void> {
  try {
    const fingerprint = await readNetworkFingerprint()
    if (fingerprint === null) {
      return
    }
    const record: HostPathRecord = { path, fingerprint }
    await AsyncStorage.setItem(storageKey(hostId), JSON.stringify(record))
  } catch {
    // A lost record only costs the next cold start a relay dial alongside direct.
  }
}

// iOS gives no SSID without an entitlement, so the local /24 stands in for it. Cellular uses the type
// alone because carrier addresses churn; so does any network without a Wi-Fi address (Android VPN on cellular).
async function readNetworkFingerprint(): Promise<string | null> {
  const [state, ip] = await Promise.all([getNetworkStateAsync(), getIpAddressAsync()])
  const type = state.type
  // iOS reports UNKNOWN while a VPN such as Tailscale is up, so it still gets a fingerprint.
  if (!type || type === NetworkStateType.NONE) {
    return null
  }
  if (type === NetworkStateType.CELLULAR) {
    return type
  }
  const subnet = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip)?.[1]
  return subnet && ip !== '0.0.0.0' ? `${type}:${subnet}` : type
}

function parseRecord(stored: string | null): HostPathRecord | null {
  if (!stored) {
    return null
  }
  const value: unknown = JSON.parse(stored)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('path' in value) ||
    !('fingerprint' in value)
  ) {
    return null
  }
  const { path, fingerprint } = value
  return (path === 'direct' || path === 'relay') && typeof fingerprint === 'string'
    ? { path, fingerprint }
    : null
}

function storageKey(hostId: string): string {
  return `${STORAGE_KEY_PREFIX}${hostId}`
}
