export function pairingCredentialAvailableWhileLocked(key: string, platform: string): boolean {
  return (
    platform === 'ios' &&
    (key.startsWith('orca.host-token.') ||
      key.startsWith('orca.mobile-relay.credentials.') ||
      key === 'orca.notification-reply-key.v1')
  )
}
