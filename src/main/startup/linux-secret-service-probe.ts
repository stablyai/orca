import { runProcessSync } from '../../shared/child-process/run-process'
import type { SecretServiceCollectionState } from './linux-keyring-backend-selection'

/**
 * Ask the secret service whether its default collection is unlocked, out of process.
 *
 * Why out of process and not through safeStorage: the in-process answer is exactly the
 * call that can block for 76s against a locked keyring with no unlock prompter
 * (STA-5765), and it is synchronous, so there is no way to abandon it. A child we spawn
 * can be killed on a timeout.
 *
 * Why a property read and not a password lookup: reading `Locked` never triggers an
 * unlock prompt, so the probe itself cannot become the stall it is meant to detect.
 *
 * Why gdbus: it ships with glib, which Electron already links, so it is present
 * wherever this app runs. Anything unexpected — missing tool, no name owner, no
 * default alias, timeout — reports `unavailable`, which keeps Chromium's own choice.
 */

const PROBE_TIMEOUT_MS = 1_500
/** gdbus takes seconds; keep it under our own kill so gdbus reports the error itself. */
const DBUS_CALL_TIMEOUT_SECONDS = '1'

export function probeSecretServiceCollection(): SecretServiceCollectionState {
  // Bare program name is safe here: this path is Linux-only, where spawn does not
  // resolve relative to the cwd the way Windows does.
  let result: { code: number | null; stdout: string; timedOut: boolean }
  try {
    result = runProcessSync({
      program: 'gdbus',
      args: [
        'call',
        '--session',
        '--timeout',
        DBUS_CALL_TIMEOUT_SECONDS,
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        '/org/freedesktop/secrets/aliases/default',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.freedesktop.Secret.Collection',
        'Locked'
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4_096
    })
  } catch {
    return 'unavailable'
  }
  if (result.timedOut || result.code !== 0) {
    return 'unavailable'
  }
  // gdbus prints the variant-wrapped property: "(<true>,)" or "(<false>,)".
  const stdout = result.stdout
  if (stdout.includes('<false>')) {
    return 'unlocked'
  }
  return stdout.includes('<true>') ? 'locked' : 'unavailable'
}
