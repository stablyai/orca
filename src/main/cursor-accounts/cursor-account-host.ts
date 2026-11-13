import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CursorSavedAccountsState } from '../../shared/cursor-account-types'
import { createEncryptedCursorAccountStore } from './cursor-account-store'
import { CursorAccountService } from './cursor-account-service'
import { createCursorMacOSCredentialBackend } from './cursor-macos-credential-backend'

let service: CursorAccountService | null = null

const UNSUPPORTED_STATE: CursorSavedAccountsState = {
  supported: false,
  accounts: [],
  activeAccountId: null,
  selectedAccountId: null,
  currentUnsaved: false
}

export function getCursorAccountVaultPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'cursor-accounts', 'vault')
}

export function getCursorAccountService(): CursorAccountService | null {
  if (process.platform !== 'darwin') {
    return null
  }
  service ??= new CursorAccountService(
    createEncryptedCursorAccountStore(getCursorAccountVaultPath()),
    createCursorMacOSCredentialBackend()
  )
  return service
}

export async function listCursorAccounts(): Promise<CursorSavedAccountsState> {
  return (await getCursorAccountService()?.list()) ?? UNSUPPORTED_STATE
}

function requireService(): CursorAccountService {
  const active = getCursorAccountService()
  if (!active) {
    throw new Error('Cursor account switching is only available on macOS.')
  }
  return active
}

export const addCurrentCursorAccount = (): Promise<CursorSavedAccountsState> =>
  requireService().addCurrent()
export const selectCursorAccount = (id: string): Promise<CursorSavedAccountsState> =>
  requireService().select(id)
export const removeCursorAccount = (id: string): Promise<CursorSavedAccountsState> =>
  requireService().remove(id)
