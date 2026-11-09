import { execFile as execFileCb } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/lsof-nonblocking-args'
import { readLibprocProcessFilePath } from '../../shared/libproc-addon'

// Coalesce/cache per-PID cwd reads briefly so rapid pane actions cannot accumulate lsof subprocesses.
const CACHE_TTL_MS = 1500
const CACHE_MAX_ENTRIES = 256
const LSOF_TIMEOUT_MS = 1500

type CacheEntry = { value: string; at: number }
const resultCache = new Map<number, CacheEntry>()
const inflight = new Map<number, Promise<string>>()

export async function resolveProcessCwd(pid: number): Promise<string> {
  // Callers must own a live PID through the 1.5s TTL; reuse could otherwise return another process cwd.
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
  // Cache within the shared promise so all waiters observe the same write.
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
  // TTL alone cannot evict PIDs never queried again; bound distinct entries too.
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    resultCache.delete(oldest)
  }
}

async function doResolve(pid: number): Promise<string> {
  // Try readlink directly; a prior existence check adds an exit race without preventing read failure.
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    /* fall through */
  }

  const inProcess = await readLibprocProcessFilePath('cwd', pid)
  if (inProcess !== undefined) {
    return inProcess ?? ''
  }

  try {
    // lsof needs -a to AND PID/cwd filters; OR would return unrelated process cwd records.
    const stdout = await readCwdWithLsof(pid)
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.includes('/')) {
        // A later rmdir can race existence checks; preserve the authoritative lsof result for spawn.
        return line.slice(1)
      }
    }
  } catch {
    /* fall through */
  }

  return ''
}

// lsof stuck on a dead mount outlives its timeout (SIGTERM waits for the syscall); one per pid, not one per poll.
const liveLsofPids = new Set<number>()

function readCwdWithLsof(pid: number): Promise<string> {
  if (liveLsofPids.has(pid)) {
    return Promise.reject(new Error('lsof for this pid has not exited'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFileCb> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      reject(new Error(`lsof timed out after ${LSOF_TIMEOUT_MS}ms`))
    }, LSOF_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    // execFile timeout only sends a signal; bound a missing callback so shared lookup cannot remain cached forever.
    try {
      liveLsofPids.add(pid)
      child = execFileCb(
        'lsof',
        [...LSOF_NONBLOCKING_ARGS, '-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        {
          encoding: 'utf-8',
          timeout: LSOF_TIMEOUT_MS
        },
        (error, stdout) => {
          // execFile reports only once the child has exited.
          liveLsofPids.delete(pid)
          if (error) {
            settle(() => reject(error))
            return
          }
          settle(() => resolve(String(stdout)))
        }
      )
    } catch (error) {
      liveLsofPids.delete(pid)
      settle(() => reject(error))
    }
  })
}
