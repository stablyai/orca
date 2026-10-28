import { pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { diag } from '../browser-cookie-import-diagnostics'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  type DetectedBrowser
} from './browser-cookie-detection-types'
import type { EncryptionKeyResult } from './browser-cookie-sqlite'
import type { LinuxCookieKeyFailure } from '../../../../shared/browser-workspace-types'

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'

function runKeychainCommand(program: string, args: readonly string[], timeoutMs: number): string {
  const result = runProcessSync({ program, args, timeoutMs })
  if (result.code !== 0 || result.timedOut) {
    throw Object.assign(new Error(`${program} exited with code ${result.code ?? 'unknown'}`), {
      stderr: result.stderr
    })
  }
  return result.stdout.trim()
}

export function getEncryptionKey(
  keychainService: string,
  keychainAccount: string,
  browser?: DetectedBrowser
): EncryptionKeyResult | null {
  if (process.platform === 'darwin') {
    return getMacEncryptionKey(keychainService, keychainAccount)
  }
  if (process.platform === 'linux') {
    return getLinuxEncryptionKey(keychainService, keychainAccount)
  }
  if (process.platform === 'win32' && browser) {
    return getWindowsEncryptionKey(browser)
  }
  return null
}

export function getMacEncryptionKey(
  keychainService: string,
  keychainAccount: string
): EncryptionKeyResult | null {
  try {
    const raw = runKeychainCommand(
      'security',
      ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'],
      30_000
    )
    return {
      mode: 'aes-128-cbc',
      keysByVersion: {
        v10: pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
      }
    }
  } catch {
    return null
  }
}

export function getLinuxEncryptionKey(
  keychainService: string,
  keychainAccount: string
): EncryptionKeyResult | null {
  // Linux v10 uses "peanuts"; v11 requires OS key storage, and CBC cannot authenticate a wrong key.
  const v10Key = pbkdf2Sync('peanuts', PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')

  let keyringPassword = ''
  let keyringFailure: LinuxCookieKeyFailure = 'key-unavailable'
  const app = keychainAccount.toLowerCase().replaceAll(' ', '')
  for (const args of [
    ['lookup', 'service', keychainService, 'account', keychainAccount],
    ['lookup', 'application', app]
  ]) {
    try {
      keyringPassword = runKeychainCommand('secret-tool', args, 5_000)
      break
    } catch (error) {
      if (typeof error === 'object' && error !== null) {
        if ('code' in error && error.code === 'ENOENT') {
          keyringFailure = 'secret-tool-missing'
        } else if (
          keyringFailure !== 'secret-tool-missing' &&
          'stderr' in error &&
          typeof error.stderr === 'string' &&
          /dismissed|cancel|denied|locked/i.test(error.stderr)
        ) {
          keyringFailure = 'keyring-locked'
        }
      }
    }
  }

  if (!keyringPassword) {
    diag('  Linux cookie encryption key unavailable — v11 cookies cannot be decrypted')
    return {
      mode: 'aes-128-cbc',
      keysByVersion: { v10: v10Key },
      keyringUnavailable: true,
      keyringFailure
    }
  }

  const v11Key = pbkdf2Sync(keyringPassword, PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')
  return { mode: 'aes-128-cbc', keysByVersion: { v10: v10Key, v11: v11Key } }
}

export function getWindowsEncryptionKey(browser: DetectedBrowser): EncryptionKeyResult | null {
  const browserDef = CHROMIUM_BROWSERS.find((b) => b.family === browser.family)
  if (!browserDef) {
    return null
  }
  const root = browserRootPath(browserDef)
  if (!root) {
    return null
  }

  const localStatePath = join(root, 'Local State')
  if (!existsSync(localStatePath)) {
    return null
  }

  try {
    const raw = readFileSync(localStatePath, 'utf-8')
    const localState = JSON.parse(raw)
    const encryptedKeyB64 = localState?.os_crypt?.encrypted_key
    if (typeof encryptedKeyB64 !== 'string') {
      return null
    }

    const encryptedKey = Buffer.from(encryptedKeyB64, 'base64')
    const dpapiPrefix = Buffer.from('DPAPI', 'utf-8')
    if (!encryptedKey.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) {
      return null
    }

    // Send DPAPI data through stdin to keep it out of the PowerShell script.
    const dpapiData = encryptedKey.subarray(dpapiPrefix.length).toString('base64')
    const script = [
      'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
      'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
      '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
      '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Convert]::ToBase64String($out)'
    ].join('')

    // Hide the console and use the system PowerShell path; Electron’s PATH may differ.
    const result = runProcessSync({
      program: windowsPowerShellPath(),
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      timeoutMs: 10_000,
      input: dpapiData
    })
    if (result.code !== 0 || result.timedOut) {
      diag('  Windows DPAPI key extraction failed: PowerShell exited non-zero')
      return null
    }

    return { key: Buffer.from(result.stdout.trim(), 'base64'), mode: 'aes-256-gcm' }
  } catch (err) {
    diag(`  Windows DPAPI key extraction failed: ${String(err)}`)
    return null
  }
}
