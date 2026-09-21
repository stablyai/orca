import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'

const WSL_MANAGED_HOME_TIMEOUT_MS = 5_000

export class CodexManagedHomePath {
  constructor(private readonly validateWslPath: (distro: string, script: string) => string) {}

  getRoot(): string {
    const root = join(app.getPath('userData'), 'codex-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  assertHostOwnership(candidatePath: string, expectedAccountId: string): string {
    return assertOwnedHostCodexManagedHomePath({
      candidatePath,
      managedAccountsRoot: join(app.getPath('userData'), 'codex-accounts'),
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId
    })
  }

  async ensureForReauthentication(account: CodexManagedAccount): Promise<string> {
    const wslInfo = parseWslUncPath(account.managedHomePath)
    if (wslInfo && process.platform === 'win32') {
      await this.ensureExpectedWslHome(account, wslInfo)
      return this.assert(account.managedHomePath, account.id)
    }

    try {
      return this.assert(account.managedHomePath, account.id)
    } catch (error) {
      if (!this.isMissingHomeError(error)) {
        throw error
      }
      return this.recreateExpectedHostHome(account, error)
    }
  }

  assert(candidatePath: string, expectedAccountId?: string): string {
    const wslInfo = parseWslUncPath(candidatePath)
    if (!wslInfo) {
      return assertOwnedHostCodexManagedHomePath({
        candidatePath,
        managedAccountsRoot: this.getRoot(),
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId
      })
    }
    if (
      !wslInfo.linuxPath.includes('/.local/share/orca/codex-accounts/') ||
      !wslInfo.linuxPath.endsWith('/home')
    ) {
      throw new Error('Managed WSL Codex home is outside Orca account storage.')
    }
    if (
      expectedAccountId !== undefined &&
      !wslInfo.linuxPath.endsWith(`/.local/share/orca/codex-accounts/${expectedAccountId}/home`)
    ) {
      throw new Error('Managed WSL Codex home does not match its persisted account ID.')
    }
    if (process.platform === 'win32') {
      return this.assertWindowsWslPath(wslInfo, expectedAccountId)
    }
    return this.assertMountedWslPath(candidatePath, wslInfo.linuxPath, expectedAccountId)
  }

  private recreateExpectedHostHome(account: CodexManagedAccount, originalError: unknown): string {
    const expectedPath = join(this.getRoot(), account.id, 'home')
    if (!this.pathsEqual(account.managedHomePath, expectedPath)) {
      throw originalError
    }
    // Why: re-auth may recreate a lost empty home, but only at the exact Orca-owned path persisted for this account.
    mkdirSync(expectedPath, { recursive: true })
    writeFileSync(join(expectedPath, '.orca-managed-home'), `${account.id}\n`, 'utf-8')
    return this.assert(expectedPath, account.id)
  }

  private async ensureExpectedWslHome(
    account: CodexManagedAccount,
    wslInfo: { distro: string; linuxPath: string }
  ): Promise<void> {
    if (
      account.managedHomeRuntime !== 'wsl' ||
      account.wslDistro !== wslInfo.distro ||
      account.wslLinuxHomePath !== wslInfo.linuxPath ||
      !wslInfo.linuxPath.endsWith(`/.local/share/orca/codex-accounts/${account.id}/home`)
    ) {
      return
    }
    const result = await runWslProcess({
      distro: wslInfo.distro,
      loginPath: 'none',
      script: [
        'set -euo pipefail',
        `candidate=${quotePosixShell(wslInfo.linuxPath)}`,
        `expected_marker=${quotePosixShell(account.id)}`,
        'marker="$candidate/.orca-managed-home"',
        'if [ -e "$candidate" ] && [ ! -f "$marker" ]; then exit 41; fi',
        'if [ -f "$marker" ] && [ "$(cat "$marker")" != "$expected_marker" ]; then exit 42; fi',
        'mkdir -p -- "$candidate"',
        'printf "%s\\n" "$expected_marker" > "$marker"'
      ].join('\n'),
      shell: 'bash',
      timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
    })
    // Why: 41/42 mean the path is not this account's home; re-auth must refuse
    // rather than write credentials into someone else's directory.
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `Could not prepare the managed Codex home in WSL ${wslInfo.distro} for re-authentication.`
      )
    }
  }

  private assertWindowsWslPath(
    wslInfo: { distro: string; linuxPath: string },
    expectedAccountId?: string
  ): string {
    try {
      const canonicalLinuxPath = this.validateWslPath(
        wslInfo.distro,
        [
          'set -euo pipefail',
          `candidate=${quotePosixShell(wslInfo.linuxPath)}`,
          'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
          'candidate_real=$(readlink -f -- "$candidate")',
          'managed_root_real=$(readlink -f -- "$managed_root")',
          'test -f "$candidate_real/.orca-managed-home"',
          ...(expectedAccountId === undefined
            ? [
                'case "$candidate_real" in "$managed_root_real"/*/home) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
              ]
            : [
                `expected_marker=${quotePosixShell(expectedAccountId)}`,
                'test "$candidate_real" = "$managed_root_real/$expected_marker/home"',
                'test "$(cat "$candidate_real/.orca-managed-home")" = "$expected_marker"',
                'printf "%s\\n" "$candidate_real"'
              ])
        ].join('\n')
      ).trim()
      if (!canonicalLinuxPath) {
        throw new Error('Managed Codex home directory does not exist on disk.')
      }
      return toWindowsWslPath(canonicalLinuxPath, wslInfo.distro)
    } catch (error) {
      throw new Error('Managed WSL Codex home is outside Orca account storage.', {
        cause: error
      })
    }
  }

  private assertMountedWslPath(
    candidatePath: string,
    linuxPath: string,
    expectedAccountId?: string
  ): string {
    if (linuxPath.split('/').includes('..')) {
      throw new Error('Managed WSL Codex home is outside Orca account storage.')
    }
    if (!existsSync(candidatePath)) {
      throw new Error('Managed Codex home directory does not exist on disk.')
    }
    const markerPath = join(candidatePath, '.orca-managed-home')
    if (!existsSync(markerPath)) {
      throw new Error('Managed Codex home is missing Orca ownership marker.')
    }
    if (
      expectedAccountId !== undefined &&
      readFileSync(markerPath, 'utf-8').trim() !== expectedAccountId
    ) {
      throw new Error('Managed WSL Codex home ownership marker does not match its account ID.')
    }
    return candidatePath
  }

  private isMissingHomeError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message === 'Managed Codex home directory does not exist on disk.'
    )
  }

  private pathsEqual(left: string, right: string): boolean {
    const resolvedLeft = resolve(left)
    const resolvedRight = resolve(right)
    return process.platform === 'win32'
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight
  }
}
