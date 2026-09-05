import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS
} from '../../shared/windows-transient-lock-removal'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import type { CodexAccountAddTarget, ManagedCodexHomeLocation } from './codex-account-service-types'
import { writeFileAtomically } from './fs-utils'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import type { CodexManagedHomePath } from './codex-managed-home-path'

const WSL_MANAGED_HOME_TIMEOUT_MS = 5_000

function removeManagedHomeTreeSync(targetPath: string): void {
  // Why: codex login descendants can briefly keep Windows handles on files in
  // the managed home (e.g. log/codex-login.log); bounded retries absorb the
  // transient lock instead of failing with ENOTEMPTY and orphaning the home.
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  })
}

export class CodexManagedHomeLifecycle {
  constructor(private readonly paths: CodexManagedHomePath) {}

  async create(
    accountId: string,
    target?: CodexAccountAddTarget
  ): Promise<ManagedCodexHomeLocation> {
    const wslHome = await this.tryCreateWslHome(accountId, target)
    if (wslHome) {
      return wslHome
    }

    const managedHomePath = join(this.paths.getRoot(), accountId, 'home')
    mkdirSync(managedHomePath, { recursive: true })
    // Why: marker lets future cleanup prove the path belongs to Orca before deleting anything.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
    return {
      managedHomePath: this.paths.assert(managedHomePath, accountId),
      managedHomeRuntime: 'host',
      wslDistro: null,
      wslLinuxHomePath: null
    }
  }

  // Why: copy the auth.json from an already-authenticated CODEX_HOME (e.g. a temp
  // dir the CLI ran `codex login` into) into the managed home. Mirrors the login
  // step of doAddAccount without spawning an interactive browser flow.
  importAuthFromHome(sourceHome: string, managedHomePath: string, accountId: string): void {
    const trimmed = sourceHome.trim()
    if (!trimmed) {
      throw new Error('A Codex home directory path is required.')
    }
    const resolvedSourceHome = resolve(trimmed)
    let sourceAuthContents: string
    try {
      sourceAuthContents = readFileSync(join(resolvedSourceHome, 'auth.json'), 'utf-8')
    } catch (error) {
      // Why: "no credentials here, run codex login" is only true for a definitive
      // absence. A locked source file used to produce that advice, which sends the
      // user to re-run a login they had already completed.
      if (!isDefinitiveAbsence(error)) {
        throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
      }
      throw new Error(
        `No Codex credentials found in ${resolvedSourceHome}. Run \`codex login\` into this directory first.`
      )
    }
    const trustedHome = this.paths.assert(managedHomePath, accountId)
    writeFileAtomically(join(trustedHome, 'auth.json'), sourceAuthContents, { mode: 0o600 })
  }

  /**
   * Rollback deletes the managed home, so it may only run on a *proven* failure.
   * An unreadable credential file means the login may well have succeeded, and a
   * kept home is a recoverable leak where a deleted one is permanent data loss.
   */
  removeUnlessUnproven(error: unknown, managedHomePath: string, accountId: string): void {
    if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
      return
    }
    this.safeRemove(managedHomePath, accountId)
  }

  safeRemove(candidatePath: string, expectedAccountId: string): void {
    let managedHomePath: string
    try {
      managedHomePath = this.paths.assert(candidatePath, expectedAccountId)
    } catch (error) {
      console.warn('[codex-accounts] Refusing to remove untrusted managed home:', error)
      return
    }

    try {
      removeManagedHomeTreeSync(managedHomePath)
    } catch (error) {
      // Why: this runs from error-cleanup paths; a still-held Windows handle
      // must not mask the original failure with an ENOTEMPTY from rmSync.
      console.warn('[codex-accounts] Failed to remove managed home:', error)
      return
    }

    if (parseWslUncPath(managedHomePath)) {
      try {
        removeManagedHomeTreeSync(dirname(managedHomePath))
      } catch {
        // Best-effort cleanup
      }
      return
    }

    // Why: homes live at <accounts-root>/<uuid>/home; removing the home/ leaf leaves an empty <uuid>/ behind.
    try {
      const parentDir = resolve(managedHomePath, '..')
      // Why: canonicalize the root too so the prefix check works on macOS where userData resolves through /private/var.
      const root = realpathSync(this.paths.getRoot())
      if (parentDir.startsWith(root + sep) && parentDir !== root) {
        removeManagedHomeTreeSync(parentDir)
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async tryCreateWslHome(
    accountId: string,
    target?: CodexAccountAddTarget
  ): Promise<ManagedCodexHomeLocation | null> {
    if (process.platform !== 'win32' || target?.runtime !== 'wsl') {
      return null
    }
    const requestedDistro = target.wslDistro?.trim() || undefined
    const info = await runWslProcess({
      distro: requestedDistro,
      loginPath: 'none',
      script: 'printf "%s\\n%s\\n" "$WSL_DISTRO_NAME" "$HOME"',
      shell: 'bash',
      timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
    })
    if (info.code !== 0 || info.timedOut) {
      throw new Error('Could not resolve the active WSL home directory for Codex login.')
    }
    const [rawDistro, rawHome] = info.stdout
      .replaceAll(String.fromCharCode(0), '')
      .split(/\r?\n/)
      .map((line) => line.trim())
    const distro = requestedDistro || rawDistro
    const home = rawHome
    if (!distro || !home?.startsWith('/')) {
      throw new Error('Could not resolve the active WSL home directory for Codex login.')
    }

    const linuxPath = `${home.replace(/\/$/, '')}/.local/share/orca/codex-accounts/${accountId}/home`
    const markerPath = `${linuxPath}/.orca-managed-home`
    const created = await runWslProcess({
      distro,
      loginPath: 'none',
      script: `mkdir -p ${quotePosixShell(linuxPath)} && printf '%s\\n' ${quotePosixShell(accountId)} > ${quotePosixShell(markerPath)}`,
      shell: 'bash',
      timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
    })
    if (created.code !== 0 || created.timedOut) {
      throw new Error('Could not create the managed Codex home inside WSL.')
    }

    const managedHomePath = toWindowsWslPath(linuxPath, distro)
    try {
      return {
        managedHomePath: this.paths.assert(managedHomePath, accountId),
        managedHomeRuntime: 'wsl',
        wslDistro: distro,
        wslLinuxHomePath: linuxPath
      }
    } catch (error) {
      await this.safeRemoveWslCandidate(distro, linuxPath, accountId)
      throw error
    }
  }

  private async safeRemoveWslCandidate(
    distro: string,
    linuxHomePath: string,
    expectedAccountId: string
  ): Promise<void> {
    // Why: creation can fail after mkdir/marker but before trust, so cleanup must verify the marker/account ID inside WSL.
    try {
      const result = await runWslProcess({
        distro,
        loginPath: 'none',
        script: [
          'set -euo pipefail',
          `candidate=${quotePosixShell(linuxHomePath)}`,
          `expected_marker=${quotePosixShell(expectedAccountId)}`,
          'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
          'candidate_real=$(readlink -f -- "$candidate" 2>/dev/null || true)',
          'managed_root_real=$(readlink -f -- "$managed_root" 2>/dev/null || true)',
          'test -n "$candidate_real"',
          'test -n "$managed_root_real"',
          'case "$candidate_real" in "$managed_root_real"/*/home) ;; *) exit 0 ;; esac',
          'test -f "$candidate_real/.orca-managed-home"',
          'test "$(cat "$candidate_real/.orca-managed-home")" = "$expected_marker"',
          'rm -rf -- "$candidate_real"',
          'parent_dir=$(dirname -- "$candidate_real")',
          'case "$parent_dir" in "$managed_root_real"/*) rmdir -- "$parent_dir" 2>/dev/null || true ;; esac'
        ].join('\n'),
        shell: 'bash',
        timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
      })
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`WSL cleanup exited with ${result.timedOut ? 'a timeout' : result.code}`)
      }
    } catch (error) {
      console.warn('[codex-accounts] Failed to clean up WSL managed home candidate:', error)
    }
  }
}
