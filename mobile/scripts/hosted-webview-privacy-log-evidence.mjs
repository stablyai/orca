const markerPatterns = {
  privilegedField: /\b(?:deviceToken|publicKeyB64|hostIdentity|credential-secret)\b/gi,
  tokenStorage: /orca(?:\.host-token\.|:web-host-token:)/gi,
  nativeAuthority:
    /(?:openHostLogicalClient|scheduleHostCredentialCleanup|resolvePairingHostIdentity)/g,
  privateOriginUrl: /orca-mobile-web:\/\/[A-Za-z0-9_-]{20,}/g,
  webSocketUrl: /wss?:\/\/[^\s"'<>]+/gi,
  fixtureMarker: /\b(?:EXPO_PUBLIC_)?ORCA_E2E_[A-Z0-9_]+\b/g
}

export function hostedWebViewPrivacyLogEvidence(source, platform) {
  const counts = Object.fromEntries(
    Object.entries(markerPatterns).map(([name, pattern]) => [
      name,
      source.match(pattern)?.length ?? 0
    ])
  )
  if (Object.values(counts).some((count) => count > 0)) {
    throw new Error(`Hosted ${platform} privacy log audit failed: ${JSON.stringify(counts)}`)
  }
  return { logBytes: Buffer.byteLength(source), counts }
}
