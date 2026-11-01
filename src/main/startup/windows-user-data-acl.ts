import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grantDirAclAsync } from '../win32-utils'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'

/** #1152: Chromium replaces userData DACL and inherited child ACEs become inherit-only, causing EPERM. Grant explicit root/immediate-child access once per identity; inherited propagation covers descendants (full 28k-file walk measured 62s). Run in the pool; per-write EPERM retries cover startup races. */

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
  } catch {}
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
  // Serialize grants: each already propagates its subtree on a pool thread.
  for (const directory of directories) {
    try {
      await grantDirAclAsync(directory)
    } catch (error) {
      // Partial grants still help; per-write EPERM retries cover stragglers.
      failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/** Grant explicit user Full Control in background before Windows window creation; identity markers skip completed grants. */
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
  // Accept old USERNAME markers as well as native SID identity to avoid needless tree regrant.
  if (marker && (marker.identity === identity || marker.identity === process.env.USERNAME)) {
    onDone({ mode: 'marker-hit' })
    return
  }
  void (async () => {
    // Grant children first: their explicit ACEs survive Chromium replacing root DACL. Root last permits direct writes before its first reset.
    const failures: string[] = []
    let children: string[] = []
    try {
      children = childDirectories(userDataPath)
    } catch (error) {
      // Still grant root when the broken DACL prevents listing children.
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
