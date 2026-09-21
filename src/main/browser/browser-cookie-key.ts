import { pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import { diag } from './browser-cookie-import-diagnostics'
import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  type DetectedBrowser
} from './browser-cookie-detection-types'
import type { EncryptionKeyResult } from './browser-cookie-sqlite'

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'

function runKeychainCommand(program: string, args: readonly string[], timeoutMs: number): string {
  const result = runProcessSync({ program, args, timeoutMs })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`${program} exited with code ${result.code ?? 'unknown'}`)
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
  // Chromium uses v11 only with OS key storage; without it, Linux writes v10 with hardcoded
  // "peanuts". Keep eligibility explicit because CBC cannot authenticate a wrong-key result.
  const v10Key = pbkdf2Sync('peanuts', PBKDF2_SALT, 1, PBKDF2_KEY_LENGTH, 'sha1')

  let keyringPassword = ''
  try {
    // Why: GNOME keyring stores the Chrome Safe Storage password via secret-tool.
    keyringPassword = runKeychainCommand(
      'secret-tool',
      ['lookup', 'service', keychainService, 'account', keychainAccount],
      5_000
    )
  } catch {
    // Why: fall back to application-based lookup used by newer Chromium versions.
    try {
      const app = keychainAccount.toLowerCase().replaceAll(' ', '')
      keyringPassword = runKeychainCommand('secret-tool', ['lookup', 'application', app], 5_000)
    } catch {
      diag('  Linux keyring unavailable — v11 cookies cannot be decrypted')
    }
  }

  if (!keyringPassword) {
    return {
      mode: 'aes-128-cbc',
      keysByVersion: { v10: v10Key },
      keyringUnavailable: true
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

    // Why: PowerShell DPAPI decrypt is the only native-addon-free path to the master key; pass via stdin to avoid injection.
    const dpapiData = encryptedKey.subarray(dpapiPrefix.length).toString('base64')
    const script = [
      'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
      'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
      '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
      '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Convert]::ToBase64String($out)'
    ].join('')

    // Why runProcessSync and an absolute path: a bare `powershell` spawn from a
    // GUI-subsystem process opens a visible conhost that takes foreground, so
    // keystrokes typed into an Orca terminal during a cookie import land in the
    // black box (#14543), and PATH under Electron is not the user's (#11771).
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
