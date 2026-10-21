// Web sibling: the bridge carries RPC, so the page holds no device token and must not import
// the pairing keychain (expo-secure-store resolves to {} on web).
export function readHostDeviceToken(_hostId: string): Promise<string | null> {
  return Promise.resolve(null)
}

export function writeHostDeviceToken(_hostId: string, _token: string): Promise<void> {
  return Promise.resolve()
}

export function deleteHostDeviceToken(_hostId: string): Promise<void> {
  return Promise.resolve()
}
