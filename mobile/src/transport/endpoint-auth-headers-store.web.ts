// Web sibling: the bridge carries RPC, so the page holds no edge-auth secrets and must not
// import the pairing keychain (expo-secure-store resolves to {} on web).
export async function readEndpointAuthHeaders(
  _hostId: string
): Promise<Record<string, string> | null> {
  return null
}

export async function writeEndpointAuthHeaders(
  _hostId: string,
  _headers: Record<string, string>
): Promise<void> {}

export async function deleteEndpointAuthHeaders(_hostId: string): Promise<void> {}

export async function primeEndpointAuthHeaders(
  _hostId: string,
  _isCurrent?: () => boolean
): Promise<Record<string, string> | null> {
  return null
}
