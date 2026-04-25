/* oxlint-disable max-lines */
import { execSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import hostedGitInfo from 'hosted-git-info'
import { gitExecFileSync, gitExecFileAsync } from './runner'

/**
 * Check if a path is a valid git repository (regular or bare).
 */
export function isGitRepo(path: string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return false
    }
    // .git dir or file (for worktrees) or bare repo
    if (existsSync(join(path, '.git'))) {
      return true
    }
    // Might be a bare repo — ask git
    const result = gitExecFileSync(['rev-parse', '--is-inside-work-tree'], {
      cwd: path
    }).trim()
    return result === 'true'
  } catch {
    // Also check if it's a bare repo
    try {
      const result = gitExecFileSync(['rev-parse', '--is-bare-repository'], {
        cwd: path
      }).trim()
      return result === 'true'
    } catch {
      return false
    }
  }
}

/**
 * Get a human-readable name for the repo from its path.
 */
export function getRepoName(path: string): string {
  const name = basename(path)
  // Strip .git suffix from bare repos
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/**
 * Get the remote origin URL, or null if not set.
 */
export function getRemoteUrl(path: string): string | null {
  try {
    return gitExecFileSync(['remote', 'get-url', 'origin'], {
      cwd: path
    }).trim()
  } catch {
    return null
  }
}

function getGitConfigValue(path: string, key: string): string {
  try {
    return gitExecFileSync(['config', '--get', key], {
      cwd: path
    }).trim()
  } catch {
    return ''
  }
}

function normalizeUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

let cachedGhLogin: string | undefined

function getGhLogin(): string {
  if (cachedGhLogin !== undefined) {
    return cachedGhLogin
  }

  try {
    const apiLogin = execSync('gh api user -q .login', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    if (apiLogin) {
      cachedGhLogin = normalizeUsername(apiLogin)
      return cachedGhLogin
    }
  } catch {
    // Fall through to auth status parsing
  }

  try {
    // Why: gh auth status writes to stderr; redirect via shell so we can capture it.
    // Use platform-appropriate shell — /bin/bash does not exist on Windows.
    const output = execSync('gh auth status 2>&1', {
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const activeAccountMatch = output.match(
      /Active account:\s+true[\s\S]*?account\s+([A-Za-z0-9-]+)/
    )
    if (activeAccountMatch?.[1]) {
      cachedGhLogin = normalizeUsername(activeAccountMatch[1])
      return cachedGhLogin
    }

    const accountMatch = output.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/)
    const login = normalizeUsername(accountMatch?.[1] ?? '')
    if (login) {
      cachedGhLogin = login
    }
    return login
  } catch {
    // Don't cache empty results on failure — allow retry on next call
    return ''
  }
}

/**
 * Get the best username-style branch prefix for the repo.
 */
export function getGitUsername(path: string): string {
  return normalizeUsername(
    getGitConfigValue(path, 'github.user') ||
      getGitConfigValue(path, 'user.username') ||
      getGhLogin() ||
      getGitConfigValue(path, 'user.email').split('@')[0] ||
      getGitConfigValue(path, 'user.name')
  )
}

function hasGitRef(path: string, ref: string): boolean {
  try {
    gitExecFileSync(['rev-parse', '--verify', ref], {
      cwd: path
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the default base ref for new worktrees.
 * Prefer the remote primary branch over a potentially stale local branch.
 *
 * Why: returns `null` when no candidate ref is resolvable. Previously this
 * fell through to a hardcoded `'origin/main'` even when that ref did not
 * exist, which silently handed `git worktree add` a bad ref and produced
 * an opaque git error. Callers now fail loudly with a useful message, or
 * degrade gracefully for non-creation uses (e.g. hosted URL building).
 */
export function getDefaultBaseRef(path: string): string | null {
  try {
    const ref = gitExecFileSync(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      cwd: path
    }).trim()

    if (ref) {
      return ref.replace(/^refs\/remotes\//, '')
    }
  } catch {
    // Fall through to explicit remote branch probes.
  }

  if (hasGitRef(path, 'refs/remotes/origin/main')) {
    return 'origin/main'
  }
  if (hasGitRef(path, 'refs/remotes/origin/master')) {
    return 'origin/master'
  }
  if (hasGitRef(path, 'refs/heads/main')) {
    return 'main'
  }
  if (hasGitRef(path, 'refs/heads/master')) {
    return 'master'
  }

  return null
}

export async function getBaseRefDefault(path: string): Promise<string | null> {
  return getDefaultBaseRefAsync(path)
}

async function getDefaultBaseRefAsync(path: string): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      { cwd: path }
    )
    const ref = stdout.trim()
    if (ref) {
      return ref.replace(/^refs\/remotes\//, '')
    }
  } catch {
    // Fall through to explicit remote branch probes.
  }

  if (await hasGitRefAsync(path, 'refs/remotes/origin/main')) {
    return 'origin/main'
  }
  if (await hasGitRefAsync(path, 'refs/remotes/origin/master')) {
    return 'origin/master'
  }
  if (await hasGitRefAsync(path, 'refs/heads/main')) {
    return 'main'
  }
  if (await hasGitRefAsync(path, 'refs/heads/master')) {
    return 'master'
  }

  return null
}

/**
 * Resolve the default push remote for a repo.
 * Order: remote configured on the current default branch → origin → the single
 * remote when the repo has exactly one → error.
 */
export async function getDefaultRemote(path: string): Promise<string> {
  const defaultRef = await getDefaultBaseRefAsync(path)
  // Why: getDefaultBaseRefAsync returns null when no default branch can be
  // detected (e.g. a brand-new repo with no commits on origin). Guard so we
  // don't crash on .includes(); fall through to the remote-list heuristics.
  const defaultBranch = defaultRef
    ? defaultRef.includes('/')
      ? defaultRef.split('/').slice(1).join('/')
      : defaultRef
    : null

  if (defaultBranch) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--get', `branch.${defaultBranch}.remote`],
        { cwd: path }
      )
      const value = stdout.trim()
      if (value) {
        return value
      }
    } catch {
      // Fall through: branch has no explicit remote configured.
    }
  }

  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    const remotes = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) {
      return 'origin'
    }
    if (remotes.length === 1) {
      return remotes[0]
    }
    if (remotes.length === 0) {
      throw new Error('Repo has no configured git remotes.')
    }
    throw new Error(
      `Repo has multiple remotes (${remotes.join(', ')}) and no default is configured. Set branch.<default>.remote.`
    )
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Failed to resolve default remote for repo.')
  }
}

export const BASE_REF_SEARCH_ARGS = [
  'for-each-ref',
  '--format=%(refname:short)',
  '--sort=-committerdate',
  'refs/remotes/origin/',
  'refs/heads/'
]

/**
 * Filter the raw `for-each-ref` stdout produced by BASE_REF_SEARCH_ARGS
 * down to a deduped, limited list of refs that substring-match `query`.
 *
 * Why: `for-each-ref` pattern globs are prefix-matched per path segment,
 * not free-form substring globs — `refs/heads/*foo*` does not match
 * `refs/heads/FooBar`. So we list all branch refs and filter in JS.
 */
export function filterBaseRefSearchOutput(stdout: string, query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase()
  const seen = new Set<string>()
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== 'origin/HEAD')
    .filter((line) => (needle ? line.toLowerCase().includes(needle) : true))
    .filter((line) => {
      if (seen.has(line)) {
        return false
      }
      seen.add(line)
      return true
    })
    .slice(0, Math.max(1, limit))
}

export async function searchBaseRefs(path: string, query: string, limit = 25): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(BASE_REF_SEARCH_ARGS, { cwd: path })
    return filterBaseRefSearchOutput(stdout, query, limit)
  } catch {
    return []
  }
}

async function hasGitRefAsync(path: string, ref: string): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', ref], { cwd: path })
    return true
  } catch {
    return false
  }
}

export type BranchConflictKind = 'local' | 'remote'

export async function getBranchConflictKind(
  path: string,
  branchName: string
): Promise<BranchConflictKind | null> {
  if (await hasGitRefAsync(path, `refs/heads/${branchName}`)) {
    return 'local'
  }

  try {
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      { cwd: path }
    )
    // Why: refs have the form refs/remotes/<remote>/<branch>. We strip the
    // first three segments so that e.g. "feature/dashboard" only matches
    // "refs/remotes/origin/feature/dashboard", not "refs/remotes/origin/other/feature/dashboard".
    const hasRemoteConflict = stdout.split('\n').some((ref) => {
      const parts = ref.trim().split('/')
      return parts.slice(3).join('/') === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

/**
 * Build a hosted URL (e.g. GitHub, GitLab, Bitbucket) for a specific file
 * and line in the repo. Returns null when the remote isn't a recognized host.
 *
 * Why hosted-git-info: it handles SSH, HTTPS, and shorthand remote URLs
 * across multiple providers, so we don't have to maintain our own URL parser.
 */
export function getRemoteFileUrl(
  repoPath: string,
  relativePath: string,
  line: number
): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }

  const info = hostedGitInfo.fromUrl(remoteUrl)
  if (!info) {
    return null
  }

  const defaultBaseRef = getDefaultBaseRef(repoPath)
  if (!defaultBaseRef) {
    return null
  }
  const defaultBranch = defaultBaseRef.replace(/^origin\//, '')
  const browseUrl = info.browseFile(relativePath, { committish: defaultBranch })
  if (!browseUrl) {
    return null
  }

  // Why: hosted-git-info lowercases the fragment, but GitHub convention
  // uses uppercase L for line links (e.g. #L42). Append manually.
  return `${browseUrl}#L${line}`
}
