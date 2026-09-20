/**
 * Selects a Chromium password store on Linux desktops Chromium cannot detect.
 *
 * Why this exists: safeStorage seals every credential Orca keeps outside
 * GlobalSettings. Chromium picks its backend from
 * XDG_CURRENT_DESKTOP; on a compositor it does not recognise — Hyprland, sway,
 * river, niri — detection yields no backend, `safeStorage.isEncryptionAvailable()`
 * returns false, and every store falls through to its plaintext branch. The
 * secret service is usually running the whole time; Chromium just never looks.
 *
 * Why it is safe to change the backend here: this only fires on desktops where
 * detection currently fails, and where detection fails nothing was ever sealed —
 * every existing secret on such a machine is already a plaintext envelope, which
 * reads back without any backend at all. Machines that Chromium does detect keep
 * their current backend untouched, so secrets sealed under it stay readable.
 * Selecting a backend for a detected desktop is exactly the change that would
 * strand them.
 */

export type LinuxPasswordStore = 'gnome-libsecret'

/**
 * Desktops Chromium resolves on its own (base/nix/xdg_util.cc). Listed so the
 * switch is only appended where detection is known to come up empty; growing
 * this set is how a newly-supported desktop opts back out.
 */
const CHROMIUM_DETECTED_DESKTOPS = new Set([
  'CINNAMON',
  'DEEPIN',
  'GNOME',
  'KDE',
  'LXQT',
  'MATE',
  'PANTHEON',
  'UKUI',
  'UNITY',
  'XFCE'
])

function hasDetectedDesktop(currentDesktop: string | undefined): boolean {
  if (!currentDesktop) {
    return false
  }
  // XDG_CURRENT_DESKTOP is a colon-separated list ("ubuntu:GNOME"); any
  // recognised member is enough for Chromium to resolve a backend.
  return currentDesktop
    .split(':')
    .map((entry) => entry.trim().toUpperCase())
    .some((entry) => CHROMIUM_DETECTED_DESKTOPS.has(entry))
}

function hasSessionBus(env: NodeJS.ProcessEnv): boolean {
  // Why: both backends talk to the session bus. Without one, naming a backend
  // cannot help — leave Chromium's own fallback in place rather than pointing
  // it at a service that certainly is not there.
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
  if (hasDetectedDesktop(env.XDG_CURRENT_DESKTOP)) {
    return null
  }
  if (!hasSessionBus(env)) {
    return null
  }
  // Why libsecret unconditionally rather than picking kwallet for KDE-ish
  // sessions: this only runs when Chromium failed to recognise the desktop, and
  // a real Plasma session sets XDG_CURRENT_DESKTOP=KDE, which it does recognise
  // — so a kwallet branch here would almost never be reached by an actual KDE
  // user. KDE also ships org.kde.secretservicecompat, so the freedesktop Secret
  // Service that libsecret speaks is served on those desktops too.
  return 'gnome-libsecret'
}
