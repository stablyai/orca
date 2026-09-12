import { spawnSync } from 'node:child_process'
import { admitProcessTreeKill } from '../shared/child-process/process-tree-kill-gate'

/** Matches `SUBPROCESS_TIMEOUT_MS` in `process-tree-termination.ts` -- the async
 *  taskkill this mirrors bounds itself the same way. */
const TASKKILL_TIMEOUT_MS = 2_000

/**
 * Bounded, synchronous tree-kill for a `wsl.exe` root that `execFileSync`'s own
 * `timeout` has already terminated.
 *
 * Why this exists instead of routing through `runProcess`: `runProcessSync`
 * (`src/shared/child-process/run-process.ts`) hands `timeoutMs` straight to
 * Node's `spawnSync`, which has the identical root-only-kill defect this file
 * works around -- there is no termination barrier on the sync path, so
 * migrating these call sites to it would fix nothing. `execFileSync` stays the
 * spawn mechanism at the sync `wsl.exe` probes in `wsl.ts`; this adds, after
 * the fact, the tree-kill a barrier would have given for free.
 *
 * Why bounded and best-effort: by the time `execFileSync` throws `ETIMEDOUT`,
 * Node has already reaped the root, so its pid is back in Windows' recycling
 * pool -- the same window `signalProcessTree`
 * (`src/shared/child-process/process-tree-termination.ts`) guards with
 * `hasExited(child)` (see #10680). There is no live `ChildProcess` handle here
 * to re-check exit state against, so `admitProcessTreeKill` is the only guard
 * available; on refusal this does nothing further, the same fallback shape
 * `signalProcessTree` uses for a pid it will not walk.
 */
export function killTimedOutWslProcessTree(pid: number | undefined, site: string): void {
  if (process.platform !== 'win32' || !pid) {
    return
  }
  if (!admitProcessTreeKill({ pid, site, scope: 'win-taskkill-tree' })) {
    return
  }
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      timeout: TASKKILL_TIMEOUT_MS
    })
  } catch {
    /* Best-effort: the root is already gone either way. */
  }
}

/** `execFileSync`'s timeout error shape: `code: 'ETIMEDOUT'` plus the reaped root's pid. */
export function killIfTimedOut(error: unknown, site: string): void {
  const failure = error as (NodeJS.ErrnoException & { pid?: number }) | null
  if (failure?.code !== 'ETIMEDOUT') {
    return
  }
  killTimedOutWslProcessTree(failure.pid, site)
}
