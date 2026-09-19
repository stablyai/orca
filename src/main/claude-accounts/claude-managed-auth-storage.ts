import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  assertOwnedClaudeManagedAuthPath,
  ManagedClaudeAuthTemporarilyUnavailableError,
  MISSING_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'
import {
  getClaudeManagedAccountsRoot,
  MANAGED_AUTH_MARKER,
  readClaudeManagedAuthFile,
  resolveClaudeManagedAuthVerdict,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import { resolveWslManagedAuthVerdict } from './wsl-managed-auth-probe'
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
    writeFileSync(join(managedAuthPath, MANAGED_AUTH_MARKER), `${accountId}\n`, {
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

  /**
   * Removal the user asked for. Their request is the authority, so this runs no
   * ownership probe: a gate that cannot complete must not turn "remove it" into
   * "quietly keep it", which leaves credentials on disk with nothing in the UI
   * still pointing at them (STA-5674 follow-up).
   *
   * Safety comes from the spelling instead, and it is stricter than the probe it
   * replaces: the old path deleted `resolve(canonicalAuthPath, '..')`, which
   * follows a symlink out of the managed root, while this deletes only the
   * directory Orca itself would have created for this account ID.
   */
  async remove(accountId: string, candidatePath: string): Promise<void> {
    const target = this.resolveOwnSpellingAccountDir(accountId, candidatePath)
    if (target.kind === 'unresolvable') {
      // We could not work out which directory this is, so we cannot report it
      // gone. Throwing rolls the caller's settings change back, which is what
      // keeps "removed" from being said about files that are still there.
      throw new ManagedClaudeAuthTemporarilyUnavailableError(
        "Orca could not locate this account's files to remove them. Retry in a moment.",
        { cause: target.error }
      )
    }
    if (target.kind === 'foreign') {
      // Nothing of ours to delete at a path we never chose; the record can go.
      console.warn(
        '[claude-accounts] Not removing a managed auth path Orca did not choose:',
        candidatePath
      )
    } else {
      // Recursive removal never traverses a symlink -- it unlinks the link --
      // so a planted link cannot redirect this outside the root. A failure here
      // must reach the user: silently keeping the files while the account
      // disappears from settings is the orphaning this method exists to stop.
      rmSync(target.accountDir, { recursive: true, force: true })
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
  }

  /**
   * Cleanup Orca decided to do on its own after a failed add. Unlike an explicit
   * removal this has no user intent behind it, so only a dispositive verdict
   * authorises deleting anything -- including the keychain entry.
   */
  async removeAfterFailedAdd(accountId: string, candidatePath: string): Promise<void> {
    const verdict = await this.resolveVerdict(candidatePath, accountId)
    if (verdict.kind === 'indeterminate') {
      console.warn(
        '[claude-accounts] Leaving managed auth in place after a failed add:',
        verdict.error
      )
      return
    }
    await this.remove(accountId, candidatePath)
  }

  /**
   * Which directory an explicit removal may delete, decided from the persisted
   * spelling alone. `foreign` is a completed answer -- this path is not ours --
   * while `unresolvable` means we could not work the question out, and the two
   * must not both read as "nothing to do".
   */
  private resolveOwnSpellingAccountDir(
    accountId: string,
    candidatePath: string
  ):
    | { kind: 'own'; accountDir: string }
    | { kind: 'foreign' }
    | { kind: 'unresolvable'; error: unknown } {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      const suffix = `/.local/share/orca/claude-accounts/${accountId}/auth`
      return wslInfo.linuxPath.endsWith(suffix)
        ? {
            kind: 'own',
            accountDir: toWindowsWslPath(
              wslInfo.linuxPath.slice(0, -'/auth'.length),
              wslInfo.distro
            )
          }
        : { kind: 'foreign' }
    }
    let spellings: { roots: string[]; canonicalizationError: unknown }
    try {
      spellings = this.getAccountsRootSpellings()
    } catch (error) {
      return { kind: 'unresolvable', error }
    }
    const resolvedCandidate = resolve(candidatePath)
    for (const root of spellings.roots) {
      if (pathsEqual(resolvedCandidate, resolve(root, accountId, 'auth'))) {
        return { kind: 'own', accountDir: resolve(root, accountId) }
      }
    }
    // No spelling matched, but one spelling was never computed -- so "not ours"
    // is not something we actually established.
    return spellings.canonicalizationError === undefined
      ? { kind: 'foreign' }
      : { kind: 'unresolvable', error: spellings.canonicalizationError }
  }

  /**
   * Both spellings of the accounts root. The persisted path is canonical (the
   * gate that produced it resolved symlinks) while `getRoot()` is not, so a
   * userData directory behind a symlink makes the two disagree. A failed
   * realpath is reported rather than swallowed: with only the lexical spelling
   * to compare against, a non-match proves nothing.
   */
  private getAccountsRootSpellings(): { roots: string[]; canonicalizationError: unknown } {
    const root = resolve(this.getRoot())
    try {
      const canonicalRoot = realpathSync(root)
      return {
        roots: pathsEqual(canonicalRoot, root) ? [root] : [root, canonicalRoot],
        canonicalizationError: undefined
      }
    } catch (error) {
      return { roots: [root], canonicalizationError: error }
    }
  }

  async assertOwned(candidatePath: string, expectedAccountId?: string): Promise<string> {
    return assertOwnedClaudeManagedAuthPath(
      await this.resolveVerdict(candidatePath, expectedAccountId)
    )
  }

  /** Non-throwing view for callers that must branch on *why* the gate refused. */
  async resolveVerdict(
    candidatePath: string,
    expectedAccountId?: string
  ): Promise<ClaudeManagedAuthVerdict> {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      return resolveWslManagedAuthVerdict(candidatePath, wslInfo, expectedAccountId)
    }
    try {
      this.getRoot()
    } catch (error) {
      return { kind: 'indeterminate', error }
    }
    const accountId = expectedAccountId ?? this.readAccountId(candidatePath)
    if (!accountId || (expectedAccountId && accountId !== expectedAccountId)) {
      return { kind: 'untrusted', reason: MISSING_MANAGED_AUTH_MESSAGE }
    }
    return resolveClaudeManagedAuthVerdict(accountId, candidatePath, { adoptLegacyMarker: true })
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

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
