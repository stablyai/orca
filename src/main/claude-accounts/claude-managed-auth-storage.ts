import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  getClaudeManagedAccountsRoot,
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import {
  deleteManagedClaudeKeychainCredentials,
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'

export type ClaudeManagedAuthLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxAuthPath: string | null
}

export type ClaudeManagedAuthSnapshot = {
  credentialsJson: string | null
  oauthAccountJson: string | null
}

export type ClaudeManagedAuthTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class ClaudeManagedAuthStorage {
  async create(
    accountId: string,
    target?: ClaudeManagedAuthTarget
  ): Promise<ClaudeManagedAuthLocation> {
    const wslAuth = await this.tryCreateWsl(accountId, target)
    if (wslAuth) {
      return wslAuth
    }
    const managedAuthPath = join(this.getRoot(), accountId, 'auth')
    mkdirSync(managedAuthPath, { recursive: true, mode: 0o700 })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    return {
      managedAuthPath: await this.assertOwned(managedAuthPath, accountId),
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
  }

  async writeAuth(
    accountId: string,
    managedAuthPath: string,
    captured: { credentialsJson: string; oauthAccount: unknown }
  ): Promise<void> {
    await this.writeCredentials(accountId, managedAuthPath, captured.credentialsJson)
    await this.writeOauthAccount(accountId, managedAuthPath, captured.oauthAccount)
  }

  async writeCredentials(
    accountId: string,
    managedAuthPath: string,
    credentialsJson: string
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(accountId, credentialsJson)
    } else {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', credentialsJson)
    }
  }

  async writeOauthAccount(
    accountId: string,
    managedAuthPath: string,
    oauthAccount: unknown
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    writeClaudeManagedAuthFile(
      trustedPath,
      'oauth-account.json',
      `${JSON.stringify(oauthAccount, null, 2)}\n`
    )
  }

  async readSnapshot(
    accountId: string,
    managedAuthPath: string
  ): Promise<ClaudeManagedAuthSnapshot> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    return {
      credentialsJson:
        process.platform === 'darwin'
          ? await readManagedClaudeKeychainCredentials(accountId)
          : readClaudeManagedAuthFile(trustedPath, '.credentials.json'),
      oauthAccountJson: readClaudeManagedAuthFile(trustedPath, 'oauth-account.json')
    }
  }

  async restoreCredentials(
    accountId: string,
    managedAuthPath: string,
    snapshot: ClaudeManagedAuthSnapshot
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (process.platform === 'darwin') {
      await (snapshot.credentialsJson !== null
        ? writeManagedClaudeKeychainCredentials(accountId, snapshot.credentialsJson)
        : deleteManagedClaudeKeychainCredentials(accountId))
    } else if (snapshot.credentialsJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', snapshot.credentialsJson)
    } else {
      rmSync(join(trustedPath, '.credentials.json'), { force: true })
    }
  }

  async restoreOauth(
    accountId: string,
    managedAuthPath: string,
    snapshot: ClaudeManagedAuthSnapshot
  ): Promise<void> {
    const trustedPath = await this.assertOwned(managedAuthPath, accountId)
    if (snapshot.oauthAccountJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, 'oauth-account.json', snapshot.oauthAccountJson)
    } else {
      rmSync(join(trustedPath, 'oauth-account.json'), { force: true })
    }
  }

  async remove(accountId: string, candidatePath: string): Promise<void> {
    try {
      const managedAuthPath = await this.assertOwned(candidatePath, accountId)
      rmSync(resolve(managedAuthPath, '..'), { recursive: true, force: true })
    } catch (error) {
      console.warn('[claude-accounts] Refusing to remove untrusted managed auth:', error)
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
  }

  async assertOwned(candidatePath: string, expectedAccountId?: string): Promise<string> {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      return this.assertOwnedWsl(candidatePath, wslInfo, expectedAccountId)
    }
    this.getRoot()
    const accountId = expectedAccountId ?? this.readAccountId(candidatePath)
    if (!accountId || (expectedAccountId && accountId !== expectedAccountId)) {
      throw new Error('Managed Claude auth directory does not exist on disk.')
    }
    const trustedPath = resolveOwnedClaudeManagedAuthPath(accountId, candidatePath, {
      adoptLegacyMarker: true
    })
    if (!trustedPath) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    return trustedPath
  }

  private async tryCreateWsl(
    accountId: string,
    target?: ClaudeManagedAuthTarget
  ): Promise<ClaudeManagedAuthLocation | null> {
    if (process.platform !== 'win32' || target?.runtime !== 'wsl') {
      return null
    }
    const requestedDistro = target.wslDistro?.trim() || undefined
    const info = await runWslProcess({
      distro: requestedDistro,
      loginPath: 'none',
      shell: 'bash',
      script: 'printf "%s\\n%s\\n" "$WSL_DISTRO_NAME" "$HOME"',
      timeoutMs: 5000
    })
    const [rawDistro, rawHome] =
      info.code === 0 && !info.timedOut
        ? info.stdout
            .replaceAll(String.fromCharCode(0), '')
            .split(/\r?\n/)
            .map((line) => line.trim())
        : []
    const distro = requestedDistro || rawDistro
    const home = rawHome
    if (!distro || !home?.startsWith('/')) {
      throw new Error('Could not resolve the active WSL home directory for Claude login.')
    }
    const linuxPath = `${home.replace(/\/$/, '')}/.local/share/orca/claude-accounts/${accountId}/auth`
    const created = await runWslProcess({
      distro,
      loginPath: 'none',
      shell: 'bash',
      script: 'umask 077; mkdir -p "$1" && printf \'%s\\n\' "$2" > "$1/.orca-managed-claude-auth"',
      args: [linuxPath, accountId],
      timeoutMs: 5000
    })
    if (created.code !== 0 || created.timedOut) {
      throw new Error('Could not create the managed WSL Claude auth directory.')
    }
    const managedAuthPath = toWindowsWslPath(linuxPath, distro)
    return {
      managedAuthPath: await this.assertOwned(managedAuthPath, accountId),
      managedAuthRuntime: 'wsl',
      wslDistro: distro,
      wslLinuxAuthPath: linuxPath
    }
  }

  private async assertOwnedWsl(
    candidatePath: string,
    wslInfo: NonNullable<ReturnType<typeof parseWslUncPath>>,
    expectedAccountId?: string
  ): Promise<string> {
    if (
      !wslInfo.linuxPath.includes('/.local/share/orca/claude-accounts/') ||
      !wslInfo.linuxPath.endsWith('/auth')
    ) {
      throw new Error('Managed WSL Claude auth storage is outside Orca account storage.')
    }
    if (process.platform !== 'win32') {
      if (
        !existsSync(candidatePath) ||
        !existsSync(join(candidatePath, '.orca-managed-claude-auth'))
      ) {
        throw new Error('Managed Claude auth storage is not owned by Orca.')
      }
      return candidatePath
    }
    try {
      const expected = expectedAccountId
        ? `test "$(cat "$candidate_real/.orca-managed-claude-auth")" = ${shellQuote(expectedAccountId)}`
        : 'test -n "$(cat "$candidate_real/.orca-managed-claude-auth")"'
      const owned = await runWslProcess({
        distro: wslInfo.distro,
        loginPath: 'none',
        shell: 'bash',
        script: [
          'set -euo pipefail',
          `candidate=${shellQuote(wslInfo.linuxPath)}`,
          'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
          'candidate_real=$(readlink -f -- "$candidate")',
          'managed_root_real=$(readlink -f -- "$managed_root")',
          'test -f "$candidate_real/.orca-managed-claude-auth"',
          expected,
          'case "$candidate_real" in "$managed_root_real"/*/auth) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
        ].join('\n'),
        timeoutMs: 5000
      })
      const canonicalPath = owned.stdout.trim()
      if (owned.code !== 0 || owned.timedOut || !canonicalPath) {
        throw new Error('Managed Claude auth directory does not exist on disk.')
      }
      return toWindowsWslPath(canonicalPath, wslInfo.distro)
    } catch (error) {
      throw new Error('Managed WSL Claude auth storage is outside Orca account storage.', {
        cause: error
      })
    }
  }

  private getRoot(): string {
    const root = getClaudeManagedAccountsRoot()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  }

  private readAccountId(candidatePath: string): string | null {
    const relativePath = relative(resolve(this.getRoot()), resolve(candidatePath))
    const parts = relativePath.split(sep)
    return parts.length === 2 && parts[1] === 'auth' ? parts[0] : null
  }
}
