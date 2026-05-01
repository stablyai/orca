import { execFile as execFileCb } from 'child_process'
import { readlink } from 'fs/promises'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

/**
 * Resolve the current working directory of a local process by pid.
 *
 * Why duplicated from `src/relay/pty-shell-utils.ts`: the relay and Electron
 * main process have separate build graphs, and cross-importing across them
 * is not a pattern used in this repo. The function is short and pure, and
 * the duplication is cheaper than reshaping both bundle graphs.
 *
 * Tries `/proc/<pid>/cwd` on Linux, falls back to `lsof -d cwd` on macOS.
 * Returns `''` when neither works (including Windows, where `/proc` is
 * absent and `lsof` is not native).
 *
 * Results are coalesced and briefly cached per-pid: rapid repeat calls
 * (e.g. chained Cmd+D on macOS) reuse a single `lsof` child rather than
 * stacking concurrent subprocesses whose results the caller may discard
 * after its own timeout.
 */
const CACHE_TTL_MS = 1500
const LSOF_TIMEOUT_MS = 1500

type CacheEntry = { value: string; at: number }
const resultCache = new Map<number, CacheEntry>()
const inflight = new Map<number, Promise<string>>()

export async function resolveProcessCwd(pid: number): Promise<string> {
  // Assumes the caller holds a live reference to `pid` for the TTL window.
  // If a pid is recycled within 1.5s of a prior query, the cache would
  // return the previous process's cwd — acceptable because our callers
  // (getCwd on an active pty/session) can't outlive their pid.
  const now = Date.now()
  const cached = resultCache.get(pid)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  if (cached) {
    // Evict stale entry on read so the map can't grow unbounded across a
    // long-lived daemon session.
    resultCache.delete(pid)
  }
  const existing = inflight.get(pid)
  if (existing) {
    return existing
  }
  // Populate the cache inside the shared promise chain so every awaiter
  // (including any second caller that joined via `inflight`) observes the
  // result through the same write, rather than racing on a post-await set.
  const promise = doResolve(pid).then((value) => {
    resultCache.set(pid, { value, at: Date.now() })
    inflight.delete(pid)
    return value
  })
  inflight.set(pid, promise)
  return promise
}

async function doResolve(pid: number): Promise<string> {
  // Why: skip an existsSync gate and just try the readlink. The check+read
  // pair races a concurrent process exit the same way the lsof+existsSync
  // pair did, and the catch already falls through to lsof.
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    /* fall through */
  }

  try {
    const { stdout } = await execFile('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: LSOF_TIMEOUT_MS
    })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) {
        // Why: lsof -d cwd is authoritative — don't second-guess it with
        // existsSync. A concurrent rmdir would race the check and cause us
        // to drop the correct answer; node-pty handles a missing cwd on
        // spawn anyway.
        return line.slice(1)
      }
    }
  } catch {
    /* fall through */
  }

  return ''
}
