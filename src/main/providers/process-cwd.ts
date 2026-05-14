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
const CACHE_MAX_ENTRIES = 256
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
  sweepExpiredResultCache(now)
  const cached = resultCache.get(pid)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }
  const existing = inflight.get(pid)
  if (existing) {
    return existing
  }
  // Populate the cache inside the shared promise chain so every awaiter
  // (including any second caller that joined via `inflight`) observes the
  // result through the same write, rather than racing on a post-await set.
  const promise = doResolve(pid).then((value) => {
    rememberResult(pid, value, Date.now())
    inflight.delete(pid)
    return value
  })
  inflight.set(pid, promise)
  return promise
}

function sweepExpiredResultCache(now: number): void {
  for (const [cachedPid, entry] of resultCache) {
    if (now - entry.at >= CACHE_TTL_MS) {
      resultCache.delete(cachedPid)
    }
  }
}

function rememberResult(pid: number, value: string, now: number): void {
  resultCache.set(pid, { value, at: now })
  // Why: terminals can churn through many OS PIDs in one app session. A short
  // TTL only helps if the old PID is queried again, so also bound unique keys.
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    resultCache.delete(oldest)
  }
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
    // Why: `-a` ANDs the -p and -d filters. Without it, macOS lsof ORs them
    // and emits cwd records for every process on the system, so the n-line
    // scan below picks up the first unrelated process (often pid ~391 with
    // cwd `/`) and returns `/` regardless of the target pid's real cwd.
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
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
