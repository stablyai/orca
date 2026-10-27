import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getSystem32ExePath } from '../win32-utils'

// Codex's elevated sandbox runs commands as members of this local group (codex-rs windows-sandbox-rs/src/winutil.rs).
const CODEX_SANDBOX_USERS_GROUP = 'CodexSandboxUsers'
// Never the home root: the group is machine-wide and the root holds auth.json.
const SANDBOX_READABLE_ENTRIES = ['generated_images', 'skills', 'plugins'] as const
const LAUNCH_WAIT_MS = 2_000
const MARKER_POLL_MS = 5_000
const MARKER_POLL_LIMIT_MS = 30 * 60_000

// Keyed by path and inode so a recreated directory is granted again.
const grantedDirs = new Set<string>()
const pendingGrants = new Map<string, Promise<void>>()
const markerPolls = new Set<string>()

/**
 * Codex's elevated setup grants its sandbox group read on every USERPROFILE child, so ~/.codex is
 * readable; Orca's managed home sits under a protected userData DACL and never gets that ACE.
 */
export async function grantCodexSandboxReadOnManagedHome(codexHome: string): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }
  if (!hasSetupMarker(codexHome)) {
    // Codex provisions its sandbox users mid-session, after this launch.
    if (requestsElevatedSandbox(codexHome)) {
      pollForSetupMarker(codexHome)
    }
    return
  }
  // A large existing tree keeps propagating in the background instead of delaying the terminal.
  await Promise.race([
    grantEntries(codexHome),
    new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_WAIT_MS).unref())
  ])
}

function hasSetupMarker(codexHome: string): boolean {
  return existsSync(join(codexHome, '.sandbox', 'setup_marker.json'))
}

function requestsElevatedSandbox(codexHome: string): boolean {
  try {
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    // `[windows] sandbox = "elevated"` or the legacy `elevated_windows_sandbox` feature flag.
    return /\bsandbox\s*=\s*["']elevated["']|\belevated_windows_sandbox\s*=\s*true\b/.test(config)
  } catch {
    return false
  }
}

function pollForSetupMarker(codexHome: string): void {
  if (markerPolls.has(codexHome)) {
    return
  }
  markerPolls.add(codexHome)
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (hasSetupMarker(codexHome)) {
      void grantEntries(codexHome)
    } else if (Date.now() - startedAt < MARKER_POLL_LIMIT_MS) {
      return
    }
    clearInterval(timer)
    markerPolls.delete(codexHome)
  }, MARKER_POLL_MS)
  timer.unref()
}

async function grantEntries(codexHome: string): Promise<void> {
  try {
    // Created before Codex writes images so they inherit the grant.
    mkdirSync(join(codexHome, 'generated_images'), { recursive: true })
  } catch {
    // Codex creates it itself; the grant then applies on the next launch.
  }
  await Promise.all(SANDBOX_READABLE_ENTRIES.map((entry) => grantDir(join(codexHome, entry))))
}

function grantDir(dir: string): Promise<void> {
  let ino: number
  try {
    const stat = lstatSync(dir)
    // Links point into the system Codex home, which Codex already opened; icacls would follow them.
    if (!stat.isDirectory()) {
      return Promise.resolve()
    }
    ino = stat.ino
  } catch {
    return Promise.resolve()
  }
  const key = `${dir}|${ino}`
  if (grantedDirs.has(key)) {
    return Promise.resolve()
  }
  let pending = pendingGrants.get(key)
  if (!pending) {
    // Failures stay uncached so the next launch retries.
    pending = runIcaclsGrant(dir)
      .then((granted) => {
        if (granted) {
          grantedDirs.add(key)
        }
      })
      .finally(() => pendingGrants.delete(key))
    pendingGrants.set(key, pending)
  }
  return pending
}

function sandboxGroupAccount(): string {
  // Machine-qualified so a same-named domain group can never match.
  return `${process.env.COMPUTERNAME || hostname()}\\${CODEX_SANDBOX_USERS_GROUP}`
}

async function hasSandboxAce(icacls: string, path: string, flags: string): Promise<boolean> {
  const result = await runProcess({ program: icacls, args: [path], timeoutMs: 10_000 })
  return (
    result.code === 0 &&
    result.stdout.toLowerCase().includes(`${sandboxGroupAccount()}:${flags}`.toLowerCase())
  )
}

/** The last entry propagates last, so its inherited ACE shows an earlier grant finished. */
async function hasCompletedGrant(icacls: string, dir: string): Promise<boolean> {
  if (!(await hasSandboxAce(icacls, dir, '(OI)(CI)(RX)'))) {
    return false
  }
  const lastEntry = readdirSync(dir).at(-1)
  return lastEntry === undefined || (await hasSandboxAce(icacls, join(dir, lastEntry), '(I)'))
}

async function runIcaclsGrant(dir: string): Promise<boolean> {
  const icacls = getSystem32ExePath('icacls.exe')
  try {
    // A repeat grant would re-propagate through the whole tree on every Orca start.
    if (await hasCompletedGrant(icacls, dir)) {
      return true
    }
    // No timeout: killing icacls mid-propagation would leave part of the tree unreadable.
    const result = await runProcess({
      program: icacls,
      args: [dir, '/grant', `${sandboxGroupAccount()}:(OI)(CI)RX`, '/Q'],
      timeoutMs: null
    })
    if (result.code === 0) {
      return true
    }
    console.warn('[codex] sandbox read grant failed', dir, result.stderr || result.stdout)
  } catch (error) {
    console.warn('[codex] sandbox read grant failed', dir, error)
  }
  return false
}
