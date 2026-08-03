import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getIcaclsExePath, resolveCurrentWindowsIdentity } from '../win32-utils'

/**
 * Startup ACL grant for the win32 userData tree.
 *
 * Why this exists (PR #1152): Chromium's BrowserWindow constructor resets the
 * userData DACL to a Protected DACL whose propagated child ACEs carry the
 * Inherit-Only flag, so file writes inside pre-existing subdirectories
 * (codex-runtime-home, agent-hooks, …) fail with EPERM. Explicit ACEs survive
 * future DACL propagation, so granting them once fixes the tree permanently.
 *
 * Why not `icacls /T` synchronously (the previous implementation): NTFS
 * inheritance is recalculated from the immediate parent, so explicit ACEs on
 * userData + its immediate children already protect the whole tree — per-file
 * ACEs on tens of thousands of Chromium cache files are pure waste. On a real
 * 28k-file profile the recursive walk measured 62s, blocking the main thread
 * before first paint and then *timing out* (60s cap), so users paid ~1 minute
 * per launch for a grant that never completed.
 *
 * Strategy:
 * - A marker file records that the grant completed for this identity. When it
 *   matches, startup performs zero icacls spawns.
 * - When absent, the grant runs asynchronously (never blocks window creation):
 *   userData root + immediate children (`<userData>\*`). Per-write EPERM
 *   retries in codex-accounts/fs-utils and agent-hooks/installer-utils remain
 *   the backstop during the brief async window, exactly as they already were
 *   for the (common) case where the old synchronous walk timed out.
 */

export const WINDOWS_ACL_GRANT_MARKER_FILE = 'windows-acl-grant.json'
export const WINDOWS_ACL_GRANT_SCHEME_VERSION = 1

const GRANT_TIMEOUT_MS = 120_000

type WindowsAclGrantMarker = {
  schemeVersion: number
  identity: string
  grantedAt: number
}

export type WindowsAclGrantResult =
  | { mode: 'marker-hit' }
  | { mode: 'granted' }
  | { mode: 'failed'; reason: string }
  | { mode: 'no-identity' }

type EnsureOptions = {
  onDone?: (result: WindowsAclGrantResult) => void
  /** Test seam — defaults to node:child_process spawn. */
  spawnFn?: typeof spawn
  /** Test seam — defaults to the real current-user identity. */
  identity?: string | null
}

function readMarker(userDataPath: string): WindowsAclGrantMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), 'utf-8')
    ) as Partial<WindowsAclGrantMarker>
    if (
      parsed.schemeVersion === WINDOWS_ACL_GRANT_SCHEME_VERSION &&
      typeof parsed.identity === 'string'
    ) {
      return parsed as WindowsAclGrantMarker
    }
  } catch {
    // missing or corrupt → re-grant
  }
  return null
}

function writeMarker(userDataPath: string, identity: string): void {
  const marker: WindowsAclGrantMarker = {
    schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION,
    identity,
    grantedAt: Date.now()
  }
  writeFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), JSON.stringify(marker))
}

function runIcaclsGrant(
  spawnFn: typeof spawn,
  target: string,
  identity: string
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    // /C continues past per-entry errors (e.g. files locked by another
    // process); a partial grant is still strictly better than none and the
    // per-write EPERM backstop covers stragglers.
    const child = spawnFn(
      getIcaclsExePath(),
      [target, '/grant:r', `${identity}:(OI)(CI)(F)`, '/C'],
      {
        stdio: 'ignore',
        windowsHide: true
      }
    )
    let settled = false
    const settle = (ok: boolean, reason?: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(ok ? { ok } : { ok, reason })
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(false, 'timeout')
    }, GRANT_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', (error) => settle(false, error.message))
    child.on('exit', (code) => settle(code === 0, code === 0 ? undefined : `exit ${code}`))
  })
}

/**
 * Ensure the userData tree carries explicit Full Control ACEs for the current
 * user. Returns immediately; the grant itself (first launch only) runs in the
 * background. Call before BrowserWindow creation on win32.
 */
export function ensureWindowsUserDataAclGrant(
  userDataPath: string,
  options: EnsureOptions = {}
): void {
  const onDone = options.onDone ?? ((): void => undefined)
  const identity =
    options.identity !== undefined ? options.identity : resolveCurrentWindowsIdentity()
  if (!identity) {
    onDone({ mode: 'no-identity' })
    return
  }
  const marker = readMarker(userDataPath)
  if (marker && marker.identity === identity) {
    onDone({ mode: 'marker-hit' })
    return
  }
  const spawnFn = options.spawnFn ?? spawn
  void (async () => {
    // Immediate children first: those explicit ACEs are the durable fix
    // (Chromium replaces the root DACL on every BrowserWindow construction,
    // but never strips explicit ACEs from children). Root second so writes
    // directly under userData succeed before Chromium's first reset.
    const children = await runIcaclsGrant(spawnFn, join(userDataPath, '*'), identity)
    const root = await runIcaclsGrant(spawnFn, userDataPath, identity)
    if (children.ok && root.ok) {
      try {
        writeMarker(userDataPath, identity)
        onDone({ mode: 'granted' })
      } catch (error) {
        onDone({ mode: 'failed', reason: `marker write: ${String(error)}` })
      }
      return
    }
    onDone({
      mode: 'failed',
      reason: [children.reason, root.reason].filter(Boolean).join('; ') || 'unknown'
    })
  })()
}
