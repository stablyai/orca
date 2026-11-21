import { runProcessSync } from '@orca/process-host'
import type { SecretServiceCollectionState } from './linux-keyring-backend-selection'

/** Read Locked, and open a password-less collection, without prompting in a killable child: synchronous safeStorage can hang 76s with no prompter (STA-5765). Missing gdbus/service/alias or timeout yields unavailable, preserving Chromium choice. */

const PROBE_TIMEOUT_MS = 1_500
/** gdbus takes seconds; keep it under our own kill so gdbus reports the error itself. */
const DBUS_CALL_TIMEOUT_SECONDS = '1'

export function probeSecretServiceCollection(): SecretServiceCollectionState {
  const locked = readDefaultCollectionLocked()
  if (locked !== 'locked') {
    return locked
  }
  // Why: a password-less keyring (Omarchy's default) reports Locked until a client asks to open it.
  // Unlock answers prompt "/" only when it opened the collection without asking; otherwise it
  // returns a prompt object, which shows nothing until someone calls Prompt(), so this never blocks.
  return unlockWithoutPrompt() ? 'unlocked' : 'locked'
}

function readDefaultCollectionLocked(): SecretServiceCollectionState {
  const stdout = callSecretService([
    '--object-path',
    '/org/freedesktop/secrets/aliases/default',
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    'org.freedesktop.Secret.Collection',
    'Locked'
  ])
  if (stdout === null) {
    return 'unavailable'
  }
  // gdbus prints the variant-wrapped property: "(<true>,)" or "(<false>,)".
  if (stdout.includes('<false>')) {
    return 'unlocked'
  }
  return stdout.includes('<true>') ? 'locked' : 'unavailable'
}

function unlockWithoutPrompt(): boolean {
  const stdout = callSecretService([
    '--object-path',
    '/org/freedesktop/secrets',
    '--method',
    'org.freedesktop.Secret.Service.Unlock',
    "['/org/freedesktop/secrets/aliases/default']"
  ])
  // gdbus prints "([objectpath '/org/freedesktop/secrets/aliases/default'], objectpath '/')" when
  // it opened, and "([], objectpath '/org/freedesktop/secrets/prompt/u1')" when it needs a prompt.
  return stdout !== null && /^\(\[objectpath '[^']+'\], objectpath '\/'\)\s*$/.test(stdout)
}

function callSecretService(args: string[]): string | null {
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
        ...args
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4_096
    })
  } catch {
    return null
  }
  return result.timedOut || result.code !== 0 ? null : result.stdout
}
