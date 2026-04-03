import { execFile } from 'child_process'
import { promisify } from 'util'

export const execFileAsync = promisify(execFile)

// Concurrency limiter - max 4 parallel gh processes
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

export function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

// ── Owner/repo resolution for gh api --cache ──────────────────────────
const ownerRepoCache = new Map<string, { owner: string; repo: string } | null>()

/** @internal — exposed for tests only */
export function _resetOwnerRepoCache(): void {
  ownerRepoCache.clear()
}

export async function getOwnerRepo(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  if (ownerRepoCache.has(repoPath)) {
    return ownerRepoCache.get(repoPath)!
  }
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf-8'
    })
    const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
    if (match) {
      const result = { owner: match[1], repo: match[2] }
      ownerRepoCache.set(repoPath, result)
      return result
    }
  } catch {
    // ignore — non-GitHub remote or no remote
  }
  ownerRepoCache.set(repoPath, null)
  return null
}
