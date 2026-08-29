/** The host facts that decide whether the profile load may skip the OS keyring probe. */
export type KeyringProbeDeferralHost = {
  platform: NodeJS.Platform
  isServeMode: boolean
}

/**
 * Whether the profile load may answer "keyring unavailable" without asking the keyring,
 * leaving every protected slot sealed until the first window has painted (STA-5782).
 *
 * Linux only: `safeStorage.isEncryptionAvailable()` is a blocking D-Bus round trip there, and a
 * keyring that is present but locked with no unlock prompter accepts the call and never replies.
 * macOS and Windows answer promptly, so deferring would only widen the window in which secrets
 * are withheld for no gain.
 *
 * Never in serve mode: a headless host opens no window to defer behind, so the probe would land
 * after `printServeReady`, and a client could pair against a main thread already stalled on it.
 */
export function shouldDeferKeyringProbe(host: KeyringProbeDeferralHost): boolean {
  return host.platform === 'linux' && !host.isServeMode
}
