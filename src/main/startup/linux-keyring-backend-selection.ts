/**
 * Decide whether to name a `--password-store` backend for Chromium on Linux.
 *
 * Why this exists: Chromium picks its os_crypt backend from the desktop-environment
 * env vars, and recognises none of the tiling compositors (Hyprland, sway, river,
 * niri). On those it selects `basic_text`, whose key Electron never exposes, so
 * `safeStorage.isEncryptionAvailable()` is false and every credential store takes its
 * plaintext fallback — while gnome-keyring sits on the session bus, unasked (#21827).
 *
 * Why this is conservative in both directions:
 *  - It never names a backend for a desktop Chromium *does* resolve. Overriding a
 *    working selection is the one change that could strand already-sealed credentials.
 *  - It only names one when the secret service is present AND its default collection is
 *    already unlocked. A locked collection with no unlock prompter is what made
 *    `isEncryptionAvailable()` block for 76s to first window (STA-5765); refusing to
 *    select libsecret there keeps today's behaviour instead of trading silent plaintext
 *    for a frozen app.
 */

/** What the secret service can tell us about sealing, from outside Chromium. */
export type SecretServiceCollectionState =
  /** Present, and openable without an unlock prompt. */
  | 'unlocked'
  /** Present but locked: libsecret would block on a prompt Chromium cannot answer. */
  | 'locked'
  /** No owner for org.freedesktop.secrets, no default collection, or the probe failed. */
  | 'unavailable'

/**
 * Desktop tokens Chromium resolves to a real backend, lowercased.
 *
 * Sourced from Electron's documented `getSelectedStorageBackend()` mapping plus the
 * `DESKTOP_SESSION` values `base::nix::GetDesktopEnvironment` falls back to. `lxqt` is
 * here because Chromium *identifies* it and then chooses basic_text anyway — it is a
 * resolved desktop, so we leave its selection alone rather than second-guessing it.
 */
const RESOLVED_DESKTOP_TOKENS = new Set([
  'cinnamon',
  'deepin',
  'gnome',
  'kde',
  'kde4',
  'kde5',
  'kde6',
  'kde-plasma',
  'lxqt',
  'mate',
  'pantheon',
  'plasma',
  'ukui',
  'unity',
  'x-cinnamon',
  'xfce',
  'xubuntu'
])

/**
 * Env vars whose mere presence makes Chromium name a desktop, even with an
 * unrecognised `XDG_CURRENT_DESKTOP`. Missing these was the serious bug in the first
 * attempt at this fix: a KDE session reached by `KDE_FULL_SESSION` would have had its
 * kwallet selection overridden with libsecret, stranding everything already sealed.
 */
const DESKTOP_PRESENCE_VARS = [
  'GNOME_DESKTOP_SESSION_ID',
  'KDE_FULL_SESSION',
  'KDE_SESSION_VERSION'
] as const

/** True when any signal Chromium consults identifies a desktop it can map to a backend. */
export function identifiesResolvedDesktop(env: NodeJS.ProcessEnv): boolean {
  if (DESKTOP_PRESENCE_VARS.some((name) => (env[name]?.trim() ?? '') !== '')) {
    return true
  }
  // XDG_CURRENT_DESKTOP is colon-separated and case-varying in the wild ("Hyprland",
  // "sway", "GNOME:ubuntu", "X-Cinnamon").
  const tokens = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .concat(env.DESKTOP_SESSION ?? '')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
  return tokens.some((token) => RESOLVED_DESKTOP_TOKENS.has(token))
}

export type PasswordStoreDecision = {
  /** The `--password-store` value to append, or null to leave Chromium's choice alone. */
  store: 'gnome-libsecret' | null
  /** Why, for the startup log — this is the only trace a user or support has. */
  reason: string
}

export function resolveLinuxPasswordStore(input: {
  env: NodeJS.ProcessEnv
  /** An explicit user or E2E `--password-store` always wins. */
  passwordStoreAlreadySelected: boolean
  /** Deferred so the D-Bus probe never runs when the decision does not depend on it. */
  probeCollection: () => SecretServiceCollectionState
}): PasswordStoreDecision {
  if (input.passwordStoreAlreadySelected) {
    return { store: null, reason: 'an explicit --password-store was already provided' }
  }
  if ((input.env.DBUS_SESSION_BUS_ADDRESS?.trim() ?? '') === '') {
    return { store: null, reason: 'no session bus, so there is no secret service to name' }
  }
  if (identifiesResolvedDesktop(input.env)) {
    return { store: null, reason: 'Chromium resolves this desktop to a backend of its own' }
  }
  const collection = input.probeCollection()
  if (collection === 'unlocked') {
    return {
      store: 'gnome-libsecret',
      reason: 'the desktop is unrecognised and the secret service is unlocked'
    }
  }
  return {
    store: null,
    reason:
      collection === 'locked'
        ? // Selecting libsecret here is what turns plaintext into a 76s startup stall.
          'the secret service is locked, and selecting it would block on an unlock prompt'
        : 'no usable secret service answered on the session bus'
  }
}
