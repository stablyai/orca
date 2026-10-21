import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grantDirAclAsync } from '../win32-utils'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'

/**
 * Startup ACL grant for the win32 userData tree.
 *
 * Why this exists (PR #1152): Chromium's BrowserWindow constructor resets the
 * userData DACL to a Protected DACL whose propagated child ACEs carry the
 * Inherit-Only flag, so file writes inside pre-existing subdirectories
 * (codex-runtime-home, agent-hooks, …) fail with EPERM. Explicit ACEs survive
 * future DACL propagation, so granting them once fixes the tree permanently.
 *
 * Why not a recursive per-file walk: NTFS inheritance is recalculated from the
 * immediate parent, so explicit ACEs on userData + its immediate child
 * directories already protect the whole tree. On a real 28k-file profile a
 * recursive walk measured 62s.
 *
 * Strategy:
 * - A marker file records that the grant completed for this identity. When it
 *   matches, startup touches no ACL at all.
 * - When absent, the grant runs on the thread pool (never blocks window
 *   creation): each immediate child directory, then the root. Per-write EPERM
 *   retries in codex-accounts/fs-utils and agent-hooks/installer-utils remain
 *   the backstop during that window.
 */

export const WINDOWS_ACL_GRANT_MARKER_FILE = 'windows-acl-grant.json'
export const WINDOWS_ACL_GRANT_SCHEME_VERSION = 1

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

/** `*` + SID is the spelling markers written by the icacls-era grant already use. */
function currentIdentity(): string | null {
  const security = loadWindowsSecurity()
  return 'error' in security ? null : `*${security.userSid}`
}

function childDirectories(userDataPath: string): string[] {
  return readdirSync(userDataPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(userDataPath, entry.name))
}

async function grantEach(directories: string[]): Promise<string[]> {
  const failures: string[] = []
  // Sequential: each grant already walks its subtree on a pool thread.
  for (const directory of directories) {
    try {
      await grantDirAclAsync(directory)
    } catch (error) {
      // A partial grant is still strictly better than none; the per-write EPERM backstop covers stragglers.
      failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
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
  const identity = currentIdentity()
  if (!identity) {
    onDone({ mode: 'no-identity' })
    return
  }
  const marker = readMarker(userDataPath)
  // Why the legacy name too: markers written before the native grant record USERNAME, and
  // re-granting would re-walk the whole tree once for nothing.
  if (marker && (marker.identity === identity || marker.identity === process.env.USERNAME)) {
    onDone({ mode: 'marker-hit' })
    return
  }
  void (async () => {
    // Immediate children first: those explicit ACEs are the durable fix
    // (Chromium replaces the root DACL on every BrowserWindow construction,
    // but never strips explicit ACEs from children). Root second so writes
    // directly under userData succeed before Chromium's first reset.
    const failures: string[] = []
    let children: string[] = []
    try {
      children = childDirectories(userDataPath)
    } catch (error) {
      // Still grant the root: a listing the broken DACL refuses is what that grant repairs.
      failures.push(`${userDataPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    failures.push(...(await grantEach([...children, userDataPath])))
    if (failures.length === 0) {
      try {
        writeMarker(userDataPath, identity)
        onDone({ mode: 'granted' })
      } catch (error) {
        onDone({ mode: 'failed', reason: `marker write: ${String(error)}` })
      }
      return
    }
    onDone({ mode: 'failed', reason: failures.join('; ') })
  })()
}
