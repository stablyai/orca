import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import {
  decodeAntigravityKeychainValue,
  encodeAntigravityKeychainValue,
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS } from '../../shared/agent-accounts/antigravity/antigravity-account-types'

function requireMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('The Antigravity macOS credential store is unavailable on this host.')
  }
}

// Attribute reads raise no dialog, so they answer quickly or not at all.
const ATTRIBUTE_READ_WAIT_MS = 3000

const briefAccess = new AsyncLocalStorage<true>()

/** Runs `operation` with every keychain read and write in it giving up after a few seconds rather
 *  than wait for an answer to a keychain dialog: for work nobody asked for, like a chat start. */
export function withBriefKeychainAccess<T>(operation: () => Promise<T>): Promise<T> {
  return briefAccess.run(true, operation)
}

export function keychainAccessIsBrief(): boolean {
  return briefAccess.getStore() === true
}

const secretWaitMs = () =>
  keychainAccessIsBrief() ? ATTRIBUTE_READ_WAIT_MS : ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS

async function runSecurity(args: string[], timeoutMs: number, input?: string) {
  try {
    return await runProcess({
      program: '/usr/bin/security',
      args,
      input,
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
  } catch {
    // Child-process errors may embed credential-bearing output.
    throw new Error('The Antigravity macOS credential store could not be accessed.')
  }
}

export type AntigravityMacOSCredentialTarget = {
  service: string
  account: string
  keychainPath?: string
}
const nativeTarget: AntigravityMacOSCredentialTarget = { service: 'gemini', account: 'antigravity' }

// security exits with the low byte of the Security framework status.
const ITEM_NOT_FOUND = 44 // errSecItemNotFound
const ACCESS_REFUSED = new Set([51, 128]) // errSecAuthFailed (Deny), errSecUserCanceled (Cancel)
const NO_DIALOG = 36 // errSecInteractionNotAllowed: a locked keychain with no dialog to unlock it

/** The keychain refused agy's login or didn't answer: a dialog was denied, cancelled, left
 *  unanswered or couldn't be shown. */
export class AntigravityKeychainAccessError extends Error {}

const unanswered = () =>
  new AntigravityKeychainAccessError("The keychain didn't answer. Unlock it and try again.")

/** A refused or unanswered keychain call, or null when the failure was something else. */
function accessFailure(
  result: Awaited<ReturnType<typeof runProcess>>
): AntigravityKeychainAccessError | null {
  if (result.timedOut || result.code === NO_DIALOG) {
    return unanswered()
  }
  if (result.code !== null && ACCESS_REFUSED.has(result.code)) {
    return new AntigravityKeychainAccessError(
      "Orca was denied access to agy's login in the keychain. Allow it when asked to show or switch accounts."
    )
  }
  return null
}

function readFailure(result: Awaited<ReturnType<typeof runProcess>>): Error {
  return (
    accessFailure(result) ?? new Error('The Antigravity macOS credential store could not be read.')
  )
}

/** agy's keychain item as its attributes describe it, read without the secret so macOS asks for no
 *  access. `fingerprint` hashes them; they change (`mdat`) whenever agy rewrites its login. */
export type AntigravityKeychainRevision = {
  fingerprint: string
  /** `mdat` counts whole seconds, so another write before this time keeps the fingerprint. */
  stableFrom: number
  /** Read at or after `stableFrom`: no later write can share the fingerprint. */
  settled: boolean
}

const MDAT = /"mdat"<timedate>=0x[0-9A-Fa-f]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/

function stableFrom(attributes: string): number {
  const match = MDAT.exec(attributes)
  if (!match) {
    return Number.POSITIVE_INFINITY
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  return Date.UTC(year, month - 1, day, hour, minute, second) + 1000
}

/** Null when there is no item. */
export async function readAntigravityMacOSCredentialRevision(
  target = nativeTarget
): Promise<AntigravityKeychainRevision | null> {
  requireMacOS()
  const startedAt = Date.now()
  const result = await runSecurity(
    [
      'find-generic-password',
      '-s',
      target.service,
      '-a',
      target.account,
      ...(target.keychainPath ? [target.keychainPath] : [])
    ],
    ATTRIBUTE_READ_WAIT_MS
  )
  if (!result.timedOut && !result.signal && !result.outputTruncated) {
    if (result.code === ITEM_NOT_FOUND) {
      return null
    }
    if (result.code === 0 && result.stdout) {
      const stable = stableFrom(result.stdout)
      return {
        fingerprint: createHash('sha256').update(result.stdout).digest('hex'),
        stableFrom: stable,
        settled: startedAt >= stable
      }
    }
  }
  throw readFailure(result)
}

/** Whether agy's keychain item exists, read from its attributes so macOS asks for no access. */
export async function hasAntigravityMacOSCredential(target = nativeTarget): Promise<boolean> {
  return (await readAntigravityMacOSCredentialRevision(target)) !== null
}

export async function readAntigravityMacOSCredential(
  target = nativeTarget
): Promise<AntigravityNativeCredential | null> {
  requireMacOS()
  const result = await runSecurity(
    [
      'find-generic-password',
      '-s',
      target.service,
      '-a',
      target.account,
      '-w',
      ...(target.keychainPath ? [target.keychainPath] : [])
    ],
    secretWaitMs()
  )
  if (!result.timedOut && !result.signal && !result.outputTruncated) {
    if (result.code === ITEM_NOT_FOUND) {
      return null
    }
    if (result.code === 0) {
      return parseAntigravityNativeCredential(decodeAntigravityKeychainValue(result.stdout))
    }
  }
  throw readFailure(result)
}

export async function writeAntigravityMacOSCredential(
  contents: string,
  target = nativeTarget
): Promise<void> {
  requireMacOS()
  parseAntigravityNativeCredential(contents)
  const encoded = encodeAntigravityKeychainValue(contents)
  const values = [target.service, target.account, target.keychainPath ?? '']
  if (values.some((value) => /[\r\n"\\]/.test(value))) {
    throw new Error('The Antigravity macOS credential target is invalid.')
  }
  const keychain = target.keychainPath ? ` "${target.keychainPath}"` : ''
  const input = `add-generic-password -U -s "${target.service}" -a "${target.account}" -w ${encoded}${keychain}\n`
  // Avoid truncating credentials in security’s limited interactive command buffer.
  if (Buffer.byteLength(input) > 4096) {
    throw new Error('Antigravity credentials exceed the macOS credential command limit.')
  }
  const result = await runSecurity(['-i'], secretWaitMs(), input)
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw (
      accessFailure(result) ??
      new Error('The Antigravity macOS credential store could not be updated.')
    )
  }
  const actual = await readAntigravityMacOSCredential(target)
  if (actual?.contents !== contents) {
    throw new Error('The Antigravity macOS credential update could not be verified.')
  }
}
