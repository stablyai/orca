import { runProcess } from '@orca/process-host'
import {
  decodeAntigravityKeychainValue,
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'

// agy stores its login with go-keyring's Secret Service provider: keyring.Set("gemini", "antigravity").
const ITEM_ATTRIBUTES = ['service', 'gemini', 'username', 'antigravity']
const ITEM_LABEL = "Password for 'antigravity' on 'gemini'"
const LOGIN_COLLECTION = '/org/freedesktop/secrets/collection/login'
const DEFAULT_COLLECTION = '/org/freedesktop/secrets/aliases/default'
// secret-tool silently truncates stdin secrets at 8 KiB.
const MAX_SECRET_BYTES = 8191

function requireLinux(): void {
  if (process.platform !== 'linux') {
    throw new Error('The Antigravity Linux keyring is unavailable on this host.')
  }
}

async function run(program: 'gdbus' | 'secret-tool', args: string[], input?: string) {
  try {
    return await runProcess({
      program,
      args,
      input,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        program === 'gdbus'
          ? 'Antigravity account switching on Linux needs gdbus (GLib) to reach the keyring. Install it and try again.'
          : 'Antigravity account switching on Linux needs secret-tool. Install libsecret-tools (or your distribution’s equivalent) and try again.'
      )
    }
    // Child-process errors may embed credential-bearing output.
    throw new Error('The Antigravity Linux keyring could not be accessed.')
  }
}

async function getSecretServiceProperty(objectPath: string, iface: string, property: string) {
  const result = await run('gdbus', [
    'call',
    '--session',
    '--timeout',
    '5',
    '--dest',
    'org.freedesktop.secrets',
    '--object-path',
    objectPath,
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    iface,
    property
  ])
  if (result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The Antigravity Linux keyring did not respond.')
  }
  if (result.code === 0) {
    return { value: result.stdout }
  }
  if (/ServiceUnknown|NameHasNoOwner|UnknownObject|NoSuchObject/.test(result.stderr)) {
    return null
  }
  throw new Error('The Antigravity Linux keyring could not be accessed.')
}

/** Mirrors go-keyring's GetLoginCollection; null means agy falls back to its credential file. */
async function resolveAgyCollection(): Promise<string | null> {
  const collections = await getSecretServiceProperty(
    '/org/freedesktop/secrets',
    'org.freedesktop.Secret.Service',
    'Collections'
  )
  if (!collections) {
    return null
  }
  const path = collections.value.includes(`'${LOGIN_COLLECTION}'`)
    ? LOGIN_COLLECTION
    : DEFAULT_COLLECTION
  const locked = await getSecretServiceProperty(path, 'org.freedesktop.Secret.Collection', 'Locked')
  if (!locked) {
    return null
  }
  if (locked.value.includes('<true>')) {
    throw new Error(
      'Your Linux keyring is locked, so Orca cannot read or switch the Antigravity account. Unlock the keyring (for example in Passwords and Keys) and try again.'
    )
  }
  if (!locked.value.includes('<false>')) {
    throw new Error('The Antigravity Linux keyring could not be accessed.')
  }
  return path
}

async function lookup(): Promise<AntigravityNativeCredential | null> {
  const result = await run('secret-tool', ['lookup', ...ITEM_ATTRIBUTES])
  if (!result.timedOut && !result.signal && !result.outputTruncated) {
    if (result.code === 0 && result.stdout) {
      return parseAntigravityNativeCredential(decodeAntigravityKeychainValue(result.stdout))
    }
    // secret-tool exits 1 silently when no item matches.
    if (result.code === 1 && !result.stdout && !result.stderr.trim()) {
      return null
    }
  }
  throw new Error('The Antigravity Linux keyring could not be read.')
}

export async function readAntigravityLinuxCredential(): Promise<AntigravityNativeCredential | null> {
  requireLinux()
  return (await resolveAgyCollection()) ? lookup() : null
}

export async function writeAntigravityLinuxCredential(contents: string): Promise<void> {
  requireLinux()
  parseAntigravityNativeCredential(contents)
  if (Buffer.byteLength(contents) > MAX_SECRET_BYTES) {
    throw new Error('Antigravity credentials exceed the Linux keyring command limit.')
  }
  const collection = await resolveAgyCollection()
  if (!collection) {
    throw new Error('The Antigravity Linux keyring is unavailable.')
  }
  // Same attributes and collection as go-keyring, so the store replaces agy's item in place.
  const result = await run(
    'secret-tool',
    ['store', `--collection=${collection}`, `--label=${ITEM_LABEL}`, ...ITEM_ATTRIBUTES],
    contents
  )
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The Antigravity Linux keyring could not be updated.')
  }
  if ((await lookup())?.contents !== contents) {
    throw new Error('The Antigravity Linux keyring update could not be verified.')
  }
}
