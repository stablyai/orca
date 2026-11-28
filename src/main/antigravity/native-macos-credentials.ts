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

function readFailure(result: Awaited<ReturnType<typeof runProcess>>): Error {
  if (result.timedOut || result.code === NO_DIALOG) {
    return new Error("The keychain didn't answer. Unlock it and try again.")
  }
  if (result.code !== null && ACCESS_REFUSED.has(result.code)) {
    return new Error(
      "Orca was denied access to agy's login in the keychain. Allow it when asked to show or switch accounts."
    )
  }
  return new Error('The Antigravity macOS credential store could not be read.')
}

/** A hash of agy's keychain item's attributes, which change (`mdat`) whenever agy rewrites its
 *  login; null when there is no item. Read without the secret, so macOS asks for no access. */
export async function fingerprintAntigravityMacOSCredential(
  target = nativeTarget
): Promise<string | null> {
  requireMacOS()
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
      return createHash('sha256').update(result.stdout).digest('hex')
    }
  }
  throw readFailure(result)
}

/** Whether agy's keychain item exists, read from its attributes so macOS asks for no access. */
export async function hasAntigravityMacOSCredential(target = nativeTarget): Promise<boolean> {
  return (await fingerprintAntigravityMacOSCredential(target)) !== null
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
    ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS
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
  const result = await runSecurity(['-i'], ANTIGRAVITY_KEYCHAIN_PROMPT_WAIT_MS, input)
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The Antigravity macOS credential store could not be updated.')
  }
  const actual = await readAntigravityMacOSCredential(target)
  if (actual?.contents !== contents) {
    throw new Error('The Antigravity macOS credential update could not be verified.')
  }
}
