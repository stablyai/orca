// The shell carries authenticated RPC; keep device credentials and pairing-keychain imports outside the page.
export function readHostDeviceToken(_hostId: string): Promise<string | null> {
  return Promise.resolve(null)
}

export function writeHostDeviceToken(_hostId: string, _token: string): Promise<void> {
  return Promise.resolve()
}

export function deleteHostDeviceToken(_hostId: string): Promise<void> {
  return Promise.resolve()
}
