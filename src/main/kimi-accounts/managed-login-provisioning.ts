import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { KimiManagedAccount } from '../../shared/managed-account-types'
import { KIMI_MANAGED_HOME_MARKER } from './managed-home-ownership'
import type { KimiLoginInstructionHandler } from './login-runner'

export type InstallManagedKimiHooks = (homePath: string) => {
  state: 'installed' | 'not_installed' | 'partial' | 'error' | 'skipped'
  detail: string | null
}

export type RunManagedKimiLogin = (
  homePath: string,
  onInstructions: KimiLoginInstructionHandler
) => Promise<void>

const INVALID_CREDENTIAL_FILE = 'Kimi sign-in completed without a valid credential file.'
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
const MAX_ACCESS_TOKEN_LENGTH = 32_768

function hardenDirectory(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}

function assertKimiCredentialFile(credentialsDir: string, credentialPath: string): void {
  const credentialsStat = lstatSync(credentialsDir)
  const credentialStat = lstatSync(credentialPath)
  if (
    !credentialsStat.isDirectory() ||
    credentialsStat.isSymbolicLink() ||
    !credentialStat.isFile() ||
    credentialStat.isSymbolicLink() ||
    credentialStat.size <= 0 ||
    credentialStat.size > MAX_CREDENTIAL_FILE_BYTES
  ) {
    throw new Error(INVALID_CREDENTIAL_FILE)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(credentialPath, 'utf-8'))
  } catch {
    throw new Error(INVALID_CREDENTIAL_FILE)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(INVALID_CREDENTIAL_FILE)
  }
  const accessToken = (parsed as { access_token?: unknown }).access_token
  if (
    typeof accessToken !== 'string' ||
    !accessToken.trim() ||
    accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    accessToken.includes('\u0000') ||
    /[\r\n]/.test(accessToken)
  ) {
    throw new Error(INVALID_CREDENTIAL_FILE)
  }
}

function removeIncompleteHome(path: string): void {
  try {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('[kimi-accounts] failed to remove incomplete managed home', error)
  }
}

export async function provisionKimiManagedLogin(args: {
  label: string
  managedAccountsRoot: string
  installManagedHooks: InstallManagedKimiHooks
  runManagedLogin: RunManagedKimiLogin
  onInstructions: KimiLoginInstructionHandler
  persist: (account: KimiManagedAccount) => void
}): Promise<KimiManagedAccount> {
  const id = randomUUID()
  const accountRoot = join(args.managedAccountsRoot, id)
  const pendingRoot = `${accountRoot}.pending`
  const pendingHome = join(pendingRoot, 'home')
  mkdirSync(args.managedAccountsRoot, { recursive: true, mode: 0o700 })
  hardenDirectory(args.managedAccountsRoot)
  try {
    mkdirSync(pendingHome, { recursive: true, mode: 0o700 })
    hardenDirectory(pendingRoot)
    hardenDirectory(pendingHome)
    await args.runManagedLogin(pendingHome, args.onInstructions)
    const credentialsDir = join(pendingHome, 'credentials')
    const credentialPath = join(credentialsDir, 'kimi-code.json')
    if (!existsSync(credentialPath)) {
      throw new Error(INVALID_CREDENTIAL_FILE)
    }
    assertKimiCredentialFile(credentialsDir, credentialPath)
    if (process.platform !== 'win32') {
      chmodSync(join(pendingHome, 'credentials'), 0o700)
      chmodSync(credentialPath, 0o600)
      const configPath = join(pendingHome, 'config.toml')
      if (existsSync(configPath)) {
        chmodSync(configPath, 0o600)
      }
    }
    const markerPath = join(pendingHome, KIMI_MANAGED_HOME_MARKER)
    writeFileSync(markerPath, `${id}\n`, { encoding: 'utf-8', mode: 0o600 })
    const hookStatus = args.installManagedHooks(pendingHome)
    if (hookStatus.state !== 'installed') {
      throw new Error(hookStatus.detail ?? 'Could not install hooks in the managed Kimi home.')
    }
    renameSync(pendingRoot, accountRoot)
    const now = Date.now()
    const account: KimiManagedAccount = {
      id,
      label: args.label,
      managedHomePath: join(accountRoot, 'home'),
      managedHomeRuntime: 'host',
      wslDistro: null,
      wslLinuxHomePath: null,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
    args.persist(account)
    return account
  } catch (error) {
    removeIncompleteHome(pendingRoot)
    removeIncompleteHome(accountRoot)
    const message = error instanceof Error ? error.message : 'Kimi sign-in failed.'
    throw new Error(
      message
        .replaceAll(pendingRoot, '[managed home]')
        .replaceAll(accountRoot, '[managed home]')
        .replaceAll(args.managedAccountsRoot, '[managed accounts]')
    )
  }
}
