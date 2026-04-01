import { execFile, execSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    return result === 'true'
  } catch {
    // Also check if it's a bare repo
    try {
      const result = execSync('git rev-parse --is-bare-repository', {
        cwd: path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
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
    return execSync('git remote get-url origin', {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

function getGitConfigValue(path: string, key: string): string {
  try {
    return execSync(`git config --get ${key}`, {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
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
    const output = execSync('gh auth status 2>&1', {
      encoding: 'utf-8',
      shell: '/bin/bash',
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
    execSync(`git rev-parse --verify ${ref}`, {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the default base ref for new worktrees.
 * Prefer the remote primary branch over a potentially stale local branch.
 */
export function getDefaultBaseRef(path: string): string {
  try {
    const ref = execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
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

  return 'origin/main'
}

export async function getBaseRefDefault(path: string): Promise<string> {
  return getDefaultBaseRefAsync(path)
}

async function getDefaultBaseRefAsync(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      {
        cwd: path,
        encoding: 'utf-8'
      }
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

  return 'origin/main'
}

export async function searchBaseRefs(path: string, query: string, limit = 25): Promise<string[]> {
  const normalizedQuery = normalizeRefSearchQuery(query)
  if (!normalizedQuery) {
    return []
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'for-each-ref',
        '--format=%(refname:short)',
        '--sort=-committerdate',
        `refs/remotes/origin/*${normalizedQuery}*`,
        `refs/heads/*${normalizedQuery}*`
      ],
      {
        cwd: path,
        encoding: 'utf-8'
      }
    )

    const seen = new Set<string>()
    const refs = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 'origin/HEAD')
      .filter((line) => {
        if (seen.has(line)) {
          return false
        }
        seen.add(line)
        return true
      })
      .slice(0, Math.max(1, limit))

    return refs
  } catch {
    return []
  }
}

function normalizeRefSearchQuery(query: string): string {
  return query.trim().replace(/[*?[\]\\]/g, '')
}

async function hasGitRefAsync(path: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', ref], {
      cwd: path,
      encoding: 'utf-8'
    })
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
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      {
        cwd: path,
        encoding: 'utf-8'
      }
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
