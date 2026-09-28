import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getAntigravityManagedAccountsRoot,
  resolveOwnedAntigravityManagedAuthPath,
  writeAntigravityManagedAuthFile
} from './managed-auth-path'

export type AntigravityManagedAuthLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
}

export type AntigravityManagedAuthTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export class AntigravityManagedAuthStorage {
  async create(
    accountId: string,
    _target?: AntigravityManagedAuthTarget
  ): Promise<AntigravityManagedAuthLocation> {
    const managedAuthPath = join(this.getRoot(), accountId, 'auth')
    mkdirSync(managedAuthPath, { recursive: true, mode: 0o700 })
    writeFileSync(join(managedAuthPath, '.orca-managed-antigravity-auth'), `${accountId}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    return {
      managedAuthPath: await this.assertOwned(managedAuthPath, accountId),
      managedAuthRuntime: 'host',
      wslDistro: null
    }
  }

  async writeAuth(
    accountId: string,
    managedAuthPath: string,
    captured: { credentialsJson: string }
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    writeAntigravityManagedAuthFile(trustedPath, '.credentials.json', captured.credentialsJson)
  }

  async assertOwned(managedAuthPath: string, accountId: string): Promise<string> {
    const trustedPath = resolveOwnedAntigravityManagedAuthPath(accountId, managedAuthPath)
    if (!trustedPath) {
      throw new Error(`Managed auth path validation failed for account ${accountId}`)
    }
    return trustedPath
  }

  async remove(managedAuthPath: string): Promise<void> {
    rmSync(managedAuthPath, { recursive: true, force: true })
  }

  private getRoot(): string {
    return getAntigravityManagedAccountsRoot()
  }
}
