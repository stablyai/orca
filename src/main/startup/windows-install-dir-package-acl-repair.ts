import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { getIcaclsExePath } from '../win32-utils'

/**
 * Self-repair for the install-directory package ACL that
 * `windows-install-dir-acl-probe.ts` detects (electron/electron#51761).
 *
 * When the install tree carries an orphan AppContainer ACE (S-1-15-2-<x>) and no
 * well-known package grant at all, Chromium's LPAC children are denied
 * read on the shipped modules and die at init with 0x80000003. Reproduced on
 * win32 10.0.26200 / Electron 43.4.1: the GPU child dies six times and the
 * browser FATALs, or — once the GPU fallback engages `--in-process-gpu` — the
 * renderer dies on every load and the window stays blank forever.
 *
 * Two additive grants clear it. Both are required:
 * - the root grant is inheritable so files written later (an update) inherit it;
 * - the /T pass must use the FLAGLESS `(RX)`. `icacls <file> /grant
 *   "*S-1-15-2-2:(OI)(CI)(RX)"` exits 0 and reports "Failed processing 0 files"
 *   while writing no ACE at all — a silent no-op. A directory grant alone does
 *   not fix a shipped module that carries its own explicit DACL, so a /T pass
 *   that silently no-ops leaves the app just as dead as before.
 *
 * Never `/grant:r`: the install tree's SYSTEM/Administrators/user ACEs must
 * survive, and so must the orphan (removing an ACE is not ours to do).
 */

export const WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB = 'windows_install_dir_acl_repair'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE = 'windows-install-dir-acl-repair.json'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION = 1

/** `*`-prefixed so icacls reads it as a SID on every locale. */
const RESTRICTED_APP_PACKAGES_SID = '*S-1-15-2-2'
/** Root only: inheritable, so files added by a later update inherit the grant. */
export const INSTALL_DIR_ROOT_GRANT = `${RESTRICTED_APP_PACKAGES_SID}:(OI)(CI)(RX)`
/** Existing entries: flagless, the only form icacls actually writes onto a file. */
export const INSTALL_DIR_TREE_GRANT = `${RESTRICTED_APP_PACKAGES_SID}:(RX)`

const ROOT_GRANT_TIMEOUT_MS = 15_000
// A packaged Orca install tree is ~3.2k entries (a bare Electron dist is ~80, which
// is NOT the shape that ships: app.asar.unpacked and node_modules dominate). At the
// ~2.2ms/entry this repo measured for a /T walk in windows-user-data-acl.ts, that is
// ~5-7s of per-file DACL writes, each intercepted by Defender's filter driver. The
// cap covers a slow or contended volume on top of that, not a tree this size alone.
const TREE_GRANT_TIMEOUT_MS = 120_000

/** icacls localizes this; an unparsed summary reports the count as unknown. */
const FAILED_PROCESSING = /Failed processing (\d+) files?/i

export type WindowsInstallDirAclRepairResult =
  | { mode: 'marker-hit' }
  | { mode: 'repaired' }
  | { mode: 'failed'; reason: string; failedFileCount: number | null }

export type WindowsInstallDirAclRepairOptions = {
  installDir?: string
  platform?: NodeJS.Platform
  isServeMode?: boolean
  /** Test seams. */
  runProcessFn?: typeof runProcess
  recordBreadcrumb?: typeof recordDurableCrashBreadcrumb
  onDone?: (result: WindowsInstallDirAclRepairResult) => void
}

export type WindowsInstallDirAclRepairArgs = WindowsInstallDirAclRepairOptions & {
  /** Marker home; the install dir itself is exactly what we may not be able to write. */
  userDataPath: string
  /** Part of the marker key so an update re-runs against the new files. */
  appVersion: string
}

type RepairMarker = {
  schemeVersion: number
  installDir: string
  appVersion: string
  attemptedAt: number
  outcome: string
}

/**
 * The probe's verdict is the only trigger: an orphan package ACE with no
 * well-known package grant to satisfy it. A localized icacls prints those grants
 * under translated names the probe cannot match, so an unreliable name check is
 * not evidence of poison — acting on it would spawn icacls and tell a user with a
 * healthy install that their permissions are broken.
 */
export function isInstallDirAclPoisonVerdict(data: CrashReportBreadcrumbData): boolean {
  return data.matchesPoisonSignature === true && data.wellKnownNameCheckReliable !== false
}

/** The commands to hand a user whose account cannot write the install ACL. */
export function buildInstallDirAclRepairCommands(installDir: string): string[] {
  return [
    `icacls "${installDir}" /grant "${INSTALL_DIR_ROOT_GRANT}"`,
    `icacls "${installDir}" /grant "${INSTALL_DIR_TREE_GRANT}" /T /C`
  ]
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE)
}

function hasMarkerFor(args: WindowsInstallDirAclRepairArgs): boolean {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(args.userDataPath), 'utf-8')) as
      | Partial<RepairMarker>
      | undefined
    return (
      parsed?.schemeVersion === WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION &&
      parsed.installDir === args.installDir &&
      parsed.appVersion === args.appVersion
    )
  } catch {
    return false // missing or corrupt -> attempt again
  }
}

// Why write it on failure too: a standard-user Program Files install can never
// win, and re-spawning icacls on every launch forever buys nothing. Reinstall or
// update changes the key and retries.
function writeMarker(args: WindowsInstallDirAclRepairArgs, outcome: string): void {
  const marker: RepairMarker = {
    schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
    installDir: args.installDir ?? '',
    appVersion: args.appVersion,
    attemptedAt: Date.now(),
    outcome
  }
  if (!existsSync(args.userDataPath)) {
    mkdirSync(args.userDataPath, { recursive: true })
  }
  writeFileSync(markerPath(args.userDataPath), JSON.stringify(marker))
}

type GrantOutcome = {
  ok: boolean
  failedFileCount: number | null
  reason?: string
}

async function runGrant(
  runner: typeof runProcess,
  installDir: string,
  grant: string,
  extraArgs: readonly string[],
  timeoutMs: number
): Promise<GrantOutcome> {
  try {
    const result = await runner({
      program: getIcaclsExePath(),
      args: [installDir, '/grant', grant, ...extraArgs],
      timeoutMs
    })
    const summary = FAILED_PROCESSING.exec(`${result.stdout}\n${result.stderr}`)
    const failedFileCount = summary ? Number(summary[1]) : null
    if (result.timedOut) {
      return { ok: false, failedFileCount, reason: 'timeout' }
    }
    if (result.code !== 0) {
      return { ok: false, failedFileCount, reason: `exit ${result.code}` }
    }
    if (failedFileCount !== null && failedFileCount > 0) {
      return { ok: false, failedFileCount, reason: 'failed-files' }
    }
    return { ok: true, failedFileCount }
  } catch (error) {
    return {
      ok: false,
      failedFileCount: null,
      reason: sanitizeCrashReportString(String(error), 200)
    }
  }
}

async function runRepair(args: WindowsInstallDirAclRepairArgs): Promise<void> {
  const record = args.recordBreadcrumb ?? recordDurableCrashBreadcrumb
  const installDir = args.installDir ?? dirname(process.execPath)
  const resolved: WindowsInstallDirAclRepairArgs = { ...args, installDir }
  let result: WindowsInstallDirAclRepairResult
  let data: CrashReportBreadcrumbData
  try {
    if (hasMarkerFor(resolved)) {
      result = { mode: 'marker-hit' }
      data = { status: 'skipped', reason: 'marker-hit' }
    } else {
      const runner = args.runProcessFn ?? runProcess
      const root = await runGrant(
        runner,
        installDir,
        INSTALL_DIR_ROOT_GRANT,
        [],
        ROOT_GRANT_TIMEOUT_MS
      )
      // Unconditional: the root grant failing does not make the per-file pass —
      // the one that actually unblocks the shipped modules — any less worth trying.
      const tree = await runGrant(
        runner,
        installDir,
        INSTALL_DIR_TREE_GRANT,
        ['/T', '/C'],
        TREE_GRANT_TIMEOUT_MS
      )
      const failedFileCount = tree.failedFileCount ?? root.failedFileCount
      if (root.ok && tree.ok) {
        result = { mode: 'repaired' }
        data = { status: 'ok', failedFileCount: failedFileCount ?? -1 }
      } else {
        const reason = [
          root.reason && `root: ${root.reason}`,
          tree.reason && `tree: ${tree.reason}`
        ]
          .filter(Boolean)
          .join('; ')
        result = { mode: 'failed', reason, failedFileCount }
        data = {
          status: 'failed',
          reason: sanitizeCrashReportString(reason, 200),
          // -1 means icacls printed no parsable summary (a localized Windows).
          failedFileCount: failedFileCount ?? -1
        }
      }
      try {
        writeMarker(resolved, result.mode)
      } catch (error) {
        data = {
          ...data,
          markerWriteFailed: sanitizeCrashReportString(String(error), 200)
        }
      }
    }
  } catch (error) {
    result = { mode: 'failed', reason: String(error), failedFileCount: null }
    data = {
      status: 'failed',
      reason: sanitizeCrashReportString(`repair: ${String(error)}`, 200)
    }
  }
  record(WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB, data)
  args.onDone?.(result)
}

// Why once per process: the DACL cannot usefully change mid-session, and
// openMainWindow re-runs on re-activation.
let repairStarted = false

export function resetWindowsInstallDirAclRepairForTest(): void {
  repairStarted = false
}

/**
 * Fire-and-forget; returns before any spawn. Call only when the probe reported
 * `matchesPoisonSignature`. win32 only, exempt in serve mode, and it must never
 * throw into window creation.
 */
export function repairWindowsInstallDirPackageAcl(args: WindowsInstallDirAclRepairArgs): void {
  if ((args.platform ?? process.platform) !== 'win32' || args.isServeMode === true) {
    return
  }
  if (repairStarted) {
    return
  }
  repairStarted = true
  try {
    setImmediate(() => {
      void runRepair(args).catch(() => undefined)
    })
  } catch {
    // Nothing left to report to that would not throw again.
  }
}
