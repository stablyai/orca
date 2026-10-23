import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import {
  installDirPackageGrants,
  RESTRICTED_APP_PACKAGES_SID,
  type InstallDirPackageGrants
} from './windows-install-dir-package-acl-grant'

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
 * - every existing entry gets a FLAGLESS grant, because a directory grant alone
 *   does not fix a shipped module that carries its own explicit DACL.
 *
 * Both are applied in-process (windows-install-dir-package-acl-grant.ts). Never
 * a replacing grant: the install tree's SYSTEM/Administrators/user ACEs must
 * survive, and so must the orphan (removing an ACE is not ours to do).
 */

export const WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB = 'windows_install_dir_acl_repair'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE = 'windows-install-dir-acl-repair.json'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION = 1

/**
 * The same two grants spelled for a user to run by hand when the repair cannot write the ACL:
 * `*`-prefixed so icacls reads a SID on every locale, and flagless on the /T pass because
 * icacls writes nothing for `(OI)(CI)` on a file while reporting success.
 */
export const INSTALL_DIR_ROOT_GRANT = `*${RESTRICTED_APP_PACKAGES_SID}:(OI)(CI)(RX)`
export const INSTALL_DIR_TREE_GRANT = `*${RESTRICTED_APP_PACKAGES_SID}:(RX)`

export type WindowsInstallDirAclRepairResult =
  /** `alreadyRepaired`: the marker records a completed repair, not an exhausted retry budget. */
  | { mode: 'marker-hit'; alreadyRepaired: boolean }
  | { mode: 'repaired' }
  | { mode: 'failed'; reason: string; failedFileCount: number | null }

export type WindowsInstallDirAclRepairOptions = {
  installDir?: string
  platform?: NodeJS.Platform
  isServeMode?: boolean
  /**
   * A DACL reading found this tree poisoned and nothing has read it clean since — this
   * launch's probe, or a persisted poison marker from an earlier one. A marker claiming a
   * completed repair therefore describes a tree that has since been re-poisoned, or a
   * repair that silently no-opped: it stops outranking the reading. The attempt
   * budget still bounds retries.
   */
  poisonEvidenceOutstanding?: boolean
  /** Test seams. */
  grants?: InstallDirPackageGrants
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
  /** Absent on schemeVersion-1 markers written before the retry budget existed. */
  attempts?: number
}

// Why bounded rather than one-and-done: the failure modes are not all permanent.
// A Defender-locked file, a timeout or a contended volume fails one launch and
// succeeds the next, and pinning on the first failure leaves the machine blank
// forever for that version. Three is enough to stop a standard-user Program Files
// install — which can never win — from re-walking the tree on every launch.
const MAX_REPAIR_ATTEMPTS = 3

/**
 * The probe's verdict is the only trigger: an orphan package ACE with no
 * well-known package grant to satisfy it. The probe reads SDDL, so the verdict
 * holds on every Windows display language.
 */
export function isInstallDirAclPoisonVerdict(data: CrashReportBreadcrumbData): boolean {
  return data.matchesPoisonSignature === true
}

/** Text only, never run: the commands to hand a user whose account cannot write the install ACL. */
export function buildInstallDirAclRepairCommands(installDir: string): string[] {
  return [
    `icacls "${installDir}" /grant "${INSTALL_DIR_ROOT_GRANT}"`,
    `icacls "${installDir}" /grant "${INSTALL_DIR_TREE_GRANT}" /T /C`
  ]
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE)
}

/** The marker for this exact install and version, or null. */
function readMarkerFor(args: WindowsInstallDirAclRepairArgs): Partial<RepairMarker> | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(args.userDataPath), 'utf-8')) as
      | Partial<RepairMarker>
      | undefined
    if (
      parsed?.schemeVersion !== WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION ||
      parsed.installDir !== args.installDir ||
      parsed.appVersion !== args.appVersion
    ) {
      return null
    }
    return parsed
  } catch {
    return null // missing or corrupt -> attempt again
  }
}

function markerHitFor(args: WindowsInstallDirAclRepairArgs): { alreadyRepaired: boolean } | null {
  const marker = readMarkerFor(args)
  if (!marker) {
    return null
  }
  if (marker.outcome === 'repaired' && args.poisonEvidenceOutstanding !== true) {
    return { alreadyRepaired: true }
  }
  return (marker.attempts ?? 0) >= MAX_REPAIR_ATTEMPTS ? { alreadyRepaired: false } : null
}

// Why write it on failure too: re-walking the tree on every launch forever buys
// nothing, so failures spend the retry budget. Reinstall or update changes the key.
function writeMarker(args: WindowsInstallDirAclRepairArgs, outcome: string): void {
  const marker: RepairMarker = {
    schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
    installDir: args.installDir ?? '',
    appVersion: args.appVersion,
    attemptedAt: Date.now(),
    outcome,
    attempts: (readMarkerFor(args)?.attempts ?? 0) + 1
  }
  if (!existsSync(args.userDataPath)) {
    mkdirSync(args.userDataPath, { recursive: true })
  }
  writeFileSync(markerPath(args.userDataPath), JSON.stringify(marker))
}

async function runRepair(args: WindowsInstallDirAclRepairArgs): Promise<void> {
  const record = args.recordBreadcrumb ?? recordDurableCrashBreadcrumb
  const installDir = args.installDir ?? dirname(process.execPath)
  const resolved: WindowsInstallDirAclRepairArgs = { ...args, installDir }
  let result: WindowsInstallDirAclRepairResult
  let data: CrashReportBreadcrumbData
  try {
    const markerHit = markerHitFor(resolved)
    if (markerHit) {
      result = { mode: 'marker-hit', alreadyRepaired: markerHit.alreadyRepaired }
      data = { status: 'skipped', reason: 'marker-hit', alreadyRepaired: markerHit.alreadyRepaired }
    } else {
      const grants = args.grants ?? installDirPackageGrants
      const root = await grants.root(installDir)
      // Unconditional: the root grant failing does not make the per-file pass —
      // the one that actually unblocks the shipped modules — any less worth trying.
      const tree = await grants.tree(installDir)
      const failedFileCount = root.failedFileCount + tree.failedFileCount
      if (root.ok && tree.ok) {
        result = { mode: 'repaired' }
        data = { status: 'ok', failedFileCount }
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
          failedFileCount
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
 * Fire-and-forget; returns before any ACL write. Call only when the probe reported
 * `matchesPoisonSignature`. win32 only, exempt in serve mode, and it must never
 * throw into window creation.
 *
 * Returns whether THIS call dispatched the repair. A caller that waits on `onDone`
 * would otherwise wait forever on the once-per-process latch.
 */
export function repairWindowsInstallDirPackageAcl(args: WindowsInstallDirAclRepairArgs): boolean {
  if ((args.platform ?? process.platform) !== 'win32' || args.isServeMode === true) {
    return false
  }
  if (repairStarted) {
    return false
  }
  repairStarted = true
  try {
    setImmediate(() => {
      void runRepair(args).catch(() => undefined)
    })
  } catch {
    // Nothing left to report to that would not throw again.
  }
  return true
}
