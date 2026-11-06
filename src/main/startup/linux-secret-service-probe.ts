import { runProcessSync } from '@orca/process-host'
import type { SecretServiceCollectionState } from './linux-keyring-backend-selection'

/** Read Locked without prompting in a killable child: synchronous safeStorage can hang 76s with no prompter (STA-5765). Missing gdbus/service/alias or timeout yields unavailable, preserving Chromium choice. */

const PROBE_TIMEOUT_MS = 1_500
/** gdbus takes seconds; keep it under our own kill so gdbus reports the error itself. */
const DBUS_CALL_TIMEOUT_SECONDS = '1'

export function probeSecretServiceCollection(): SecretServiceCollectionState {
  // Linux-only PATH lookup avoids Windows cwd-based executable resolution.
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
