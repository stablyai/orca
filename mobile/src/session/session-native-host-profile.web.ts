type SessionNativeHostProfile = {
  deviceToken: string
  endpoint: string
}

export async function loadSessionNativeHostProfile(
  _hostId: string
): Promise<SessionNativeHostProfile | null> {
  return null
}
