import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS
} from '../../../shared/file-write/windows-transient-lock-removal'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { parseWslUncPath, toWindowsWslPath } from '../../../shared/file-access/wsl-paths'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import type {
  CodexAccountAddTarget,
  ManagedCodexHomeLocation
} from '../account-management/codex-account-service-types'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { MERGE_PENDING_SUFFIX, removeDirectoryLink } from '../../filesystem/merged-directory-link'
import {
  CODEX_DATABASE_FILE,
  HISTORY_CLEANUP_MANIFEST,
  PRE_SHARE_DATABASES_DIR,
  SET_ASIDE_ROLLOUTS_DIR
} from '../../codex/history/shared-store/codex-account-history-cleanup-manifest'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import type { CodexManagedHomePath } from './codex-managed-home-path'

const WSL_MANAGED_HOME_TIMEOUT_MS = 5_000

// Codex recorded the account's conversations under its own path in the shared index, a home
// that was busy at every launch may still hold its only copy, and a merge keeps conflicting
// copies (and set-aside rollout forms, listed in the cleanup manifest) beside the links; all of
// it outlives the login. A home that was shared (it has the manifest) keeps its own databases
// too: deleting them waits for a later release that has seen the shared store work. The prompt
// history stays as well: it may be the only copy of prompts never merged into the shared history.
const KEPT_HISTORY = [
  'history.jsonl',
  'sessions',
  'archived_sessions',
  SET_ASIDE_ROLLOUTS_DIR,
  HISTORY_CLEANUP_MANIFEST,
  PRE_SHARE_DATABASES_DIR
]
const KEEP_ON_REMOVAL_SCRIPT = [
  'set -u',
  'home=$1',
  'kept() {',
  '  case "${1##*/}" in',
  '    *.orca-profile-merge) return 0 ;;',
  `    ${KEPT_HISTORY.join(' | ')}) return 0 ;;`,
  `    *.sqlite | *.sqlite-wal | *.sqlite-shm) [ -f "$home/${HISTORY_CLEANUP_MANIFEST}" ] ;;`,
  '    *) return 1 ;;',
  '  esac',
  '}',
  'any_kept=0',
  'for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do',
  '  if kept "$entry"; then any_kept=1; fi',
  'done',
  'if [ "$any_kept" = 0 ]; then',
  '  rm -rf -- "$home"',
  '  rmdir -- "${home%/*}" 2>/dev/null || true',
  '  exit 0',
  'fi',
  // GNU rm removes a link itself, never what it points to.
  'for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do',
  '  if [ -e "$entry" ] || [ -L "$entry" ]; then kept "$entry" || rm -rf -- "$entry"; fi',
  'done'
].join('\n')

/**
 * Deletes the login and private state but keeps shared history; true when anything was kept.
 * Links are removed one by one first, so no recursive delete ever meets a Windows junction.
 */
async function removeManagedHomeKeepingSharedHistory(home: string): Promise<boolean> {
  const entries = await readdir(home, { withFileTypes: true })
  const sharedOnce = entries.some((entry) => entry.name === HISTORY_CLEANUP_MANIFEST)
  const kept = (entry: Dirent): boolean =>
    KEPT_HISTORY.includes(entry.name) ||
    entry.name.endsWith(MERGE_PENDING_SUFFIX) ||
    (sharedOnce && entry.isFile() && CODEX_DATABASE_FILE.test(entry.name))
  for (const entry of entries.filter((candidate) => !kept(candidate))) {
    const path = join(home, entry.name)
    if (entry.isSymbolicLink()) {
      // Never recurse through a link (a Windows junction included).
      await removeDirectoryLink(path)
      continue
    }
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RM_MAX_RETRIES,
      retryDelay: WINDOWS_RM_RETRY_DELAY_MS
    })
  }
  // Read again: history a writer created meanwhile must not fall to the whole-home removal.
  return (await readdir(home, { withFileTypes: true })).some(kept)
}

function removeManagedHomeTreeSync(targetPath: string): void {
  // Retry transient Windows locks held by login descendants to avoid orphaning the home.
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
    // Cleanup requires this ownership marker before deleting the home.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
    return {
      managedHomePath: await this.paths.assert(managedHomePath, accountId),
      managedHomeRuntime: 'host',
      wslDistro: null,
      wslLinuxHomePath: null
    }
  }

  async importAuthFromHome(
    sourceHome: string,
    managedHomePath: string,
    accountId: string
  ): Promise<void> {
    const trimmed = sourceHome.trim()
    if (!trimmed) {
      throw new Error('A Codex home directory path is required.')
    }
    const resolvedSourceHome = resolve(sourceHome)
    let sourceAuthContents: string
    try {
      sourceAuthContents = readFileSync(join(resolvedSourceHome, 'auth.json'), 'utf-8')
    } catch (error) {
      // An unreadable source cannot justify telling an authenticated user to log in again.
      if (!isDefinitiveAbsence(error)) {
        throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
      }
      throw new Error(
        `No Codex credentials found in ${resolvedSourceHome}. Run \`codex login\` into this directory first.`
      )
    }
    const trustedHome = await this.paths.assert(managedHomePath, accountId)
    writeFileAtomically(join(trustedHome, 'auth.json'), sourceAuthContents, { mode: 0o600 })
  }

  /** Preserve an unreadable home: rollback could destroy a successful login. */
  async removeUnlessUnproven(
    error: unknown,
    managedHomePath: string,
    accountId: string
  ): Promise<void> {
    if (error instanceof ManagedCodexHomeTemporarilyUnavailableError) {
      return
    }
    await this.safeRemove(managedHomePath, accountId)
  }

  async safeRemove(candidatePath: string, expectedAccountId: string): Promise<void> {
    let managedHomePath: string
    try {
      managedHomePath = await this.paths.assert(candidatePath, expectedAccountId)
    } catch (error) {
      console.warn('[codex-accounts] Refusing to remove untrusted managed home:', error)
      return
    }

    const wslHome = parseWslUncPath(managedHomePath)
    if (wslHome) {
      // Never walk a guest tree from Windows: a Linux link must not be followed over 9P.
      try {
        const result = await runWslProcess({
          distro: wslHome.distro,
          loginPath: 'none',
          script: KEEP_ON_REMOVAL_SCRIPT,
          args: [wslHome.linuxPath],
          shell: 'bash',
          timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
        })
        if (result.code !== 0 || result.timedOut) {
          throw new Error(`WSL cleanup exited with ${result.timedOut ? 'a timeout' : result.code}`)
        }
      } catch (error) {
        console.warn('[codex-accounts] Failed to remove managed home:', error)
      }
      return
    }

    try {
      if (await removeManagedHomeKeepingSharedHistory(managedHomePath)) {
        return
      }
      removeManagedHomeTreeSync(managedHomePath)
    } catch (error) {
      // Cleanup failures must not mask the original error.
      console.warn('[codex-accounts] Failed to remove managed home:', error)
      return
    }

    // Remove the account directory left after deleting its home leaf.
    try {
      const parentDir = resolve(managedHomePath, '..')
      // Canonicalize both sides for macOS userData paths that resolve through /private/var.
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
        managedHomePath: await this.paths.assert(managedHomePath, accountId),
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
    // Verify WSL ownership even when creation failed before the host validated the home.
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
