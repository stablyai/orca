/**
 * Selects a Chromium password store on Linux sessions Chromium cannot identify.
 *
 * Why this exists: safeStorage seals every credential Orca keeps outside
 * GlobalSettings. Chromium derives its backend from the desktop environment; on
 * a session it cannot identify — a bare wlroots compositor such as Hyprland,
 * sway, river or niri — it resolves nothing, `isEncryptionAvailable()` returns
 * false, and every store falls through to its plaintext branch. The secret
 * service is usually running the whole time; Chromium just never looks.
 *
 * Why it is safe to name a backend here: this fires only where Chromium
 * identifies no desktop at all, and where it identifies none it selects no
 * secure backend, so nothing was ever sealed and nothing can be stranded. Any
 * session Chromium does resolve — including the ones it resolves through
 * DESKTOP_SESSION or the legacy KDE_FULL_SESSION variable, which map to the
 * kwallet family — is left alone, because overriding those is what would make
 * an existing v11 blob undecryptable.
 *
 * The detection below mirrors `base::nix::GetDesktopEnvironment`
 * (base/nix/xdg_util.cc). It must stay a mirror: treating a session as
 * unidentified when Chromium identifies it risks stranding secrets, and
 * treating one as identified when Chromium does not silently leaves that
 * session on plaintext.
 */

export type LinuxPasswordStore = 'gnome-libsecret'

/**
 * XDG_CURRENT_DESKTOP members Chromium matches, spelled exactly as it spells
 * them. Chromium compares these case-sensitively, so the casing is load-bearing
 * — `X-Cinnamon` is the real token and `CINNAMON` never matches anything.
 */
const CHROMIUM_XDG_DESKTOPS = new Set([
  'Unity',
  'Deepin',
  'GNOME',
  'X-Cinnamon',
  'KDE',
  'Pantheon',
  'XFCE',
  'UKUI',
  'LXQt',
  'COSMIC'
])

/** DESKTOP_SESSION values Chromium recognises once XDG_CURRENT_DESKTOP misses. */
const CHROMIUM_DESKTOP_SESSIONS = new Set([
  'deepin',
  'gnome',
  'mate',
  'kde4',
  'kde-plasma',
  'kde',
  'xubuntu',
  'ukui'
])

/** Stage one of Chromium's detection: the XDG_CURRENT_DESKTOP member list. */
function matchesXdgDesktop(currentDesktop: string | undefined): boolean {
  if (!currentDesktop) {
    return false
  }
  // XDG_CURRENT_DESKTOP is a colon-separated list in priority order
  // ("ubuntu:GNOME"); one recognised member is enough for Chromium.
  return currentDesktop
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => CHROMIUM_XDG_DESKTOPS.has(entry))
}

/** Stage two: the DESKTOP_SESSION value, consulted only when stage one misses. */
function matchesDesktopSession(desktopSession: string | undefined): boolean {
  const session = desktopSession?.trim()
  if (!session) {
    return false
  }
  // Chromium substring-matches xfce here rather than comparing whole values.
  return session.includes('xfce') || CHROMIUM_DESKTOP_SESSIONS.has(session)
}

/**
 * Whether Chromium would identify this session's desktop.
 *
 * Covers the same three stages in the same order as GetDesktopEnvironment:
 * XDG_CURRENT_DESKTOP, then DESKTOP_SESSION, then the legacy
 * GNOME_DESKTOP_SESSION_ID / KDE_FULL_SESSION variables. Skipping a stage is
 * how a kwallet session would get overridden.
 */
function hasIdentifiedDesktop(env: NodeJS.ProcessEnv): boolean {
  return (
    matchesXdgDesktop(env.XDG_CURRENT_DESKTOP) ||
    matchesDesktopSession(env.DESKTOP_SESSION) ||
    Boolean(env.GNOME_DESKTOP_SESSION_ID) ||
    // KDE_FULL_SESSION resolves to the KDE3/KDE4 family, which selects kwallet.
    Boolean(env.KDE_FULL_SESSION)
  )
}

/**
 * Whether a session bus exists for the backend to talk to.
 *
 * Without one, naming a backend cannot help — leave Chromium's own fallback in
 * place rather than pointing it at a service that certainly is not there.
 */
function hasSessionBus(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DBUS_SESSION_BUS_ADDRESS?.trim() || env.XDG_RUNTIME_DIR?.trim())
}

/**
 * Returns the backend to request, or null to leave Chromium's detection alone.
 *
 * Pure so the decision is testable without an Electron app: the caller owns the
 * platform check and the commandLine write.
 */
export function resolveLinuxPasswordStore(
  env: NodeJS.ProcessEnv,
  options: { passwordStoreAlreadySet: boolean }
): LinuxPasswordStore | null {
  // Why: an explicit --password-store is a deliberate operator choice (E2E runs
  // pass `basic`); never second-guess it.
  if (options.passwordStoreAlreadySet) {
    return null
  }
  if (hasIdentifiedDesktop(env)) {
    return null
  }
  if (!hasSessionBus(env)) {
    return null
  }
  // libsecret rather than kwallet: an unidentified session offers no evidence
  // for KDE — every signal Chromium reads for the kwallet family is checked
  // above and none matched — and the freedesktop Secret Service that libsecret
  // speaks is what a bare compositor's keyring provides.
  return 'gnome-libsecret'
}
