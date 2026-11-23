/** Unrecognized tiling desktops fall back to basic_text despite a usable keyring (#21827). Select libsecret only for an unlocked collection; preserve recognized desktops to avoid stranding credentials and reject locked services to avoid 76s startup stalls (STA-5765). */

export type SecretServiceCollectionState =
  /** Present, and openable without an unlock prompt. */
  | 'unlocked'
  /** Present but locked: libsecret would block on a prompt Chromium cannot answer. */
  | 'locked'
  /** No owner for org.freedesktop.secrets, no default collection, or the probe failed. */
  | 'unavailable'

/** Preserve Chromium-recognized desktops, including LXQt which deliberately selects basic_text; tokens follow Electron backend mapping and Chromium desktop fallbacks. */
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

/** Presence alone may select a backend; missing KDE signals would override kwallet with libsecret and strand sealed credentials. */
const DESKTOP_PRESENCE_VARS = [
  'GNOME_DESKTOP_SESSION_ID',
  'KDE_FULL_SESSION',
  'KDE_SESSION_VERSION'
] as const

export function identifiesResolvedDesktop(env: NodeJS.ProcessEnv): boolean {
  if (DESKTOP_PRESENCE_VARS.some((name) => (env[name]?.trim() ?? '') !== '')) {
    return true
  }
  // XDG_CURRENT_DESKTOP tokens vary in case and use colon-separated composites.
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
  /** Only startup-log evidence explaining this choice. */
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
        ? // Selecting locked libsecret can turn plaintext fallback into a 76s startup stall.
          'the secret service is locked, and selecting it would block on an unlock prompt'
        : 'no usable secret service answered on the session bus'
  }
}
