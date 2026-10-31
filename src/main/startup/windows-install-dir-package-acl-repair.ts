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

/** electron/electron#51761: orphan package ACEs without well-known package grants deny LPAC module reads and kill children at init (0x80000003). Add root inheritance for future files and explicit flagless grants for existing protected files; preserve all original ACEs, including the orphan. */

export const WINDOWS_INSTALL_DIR_ACL_REPAIR_BREADCRUMB = 'windows_install_dir_acl_repair'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE = 'windows-install-dir-acl-repair.json'
export const WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION = 1

/** Manual fallback only: * forces locale-independent SID parsing; tree grants are flagless because icacls silently skips file grants with OI/CI. */
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
  /** Outstanding poison evidence outranks a completed-repair marker: the tree may be re-poisoned or the grant a silent no-op. Preserve the retry cap. */
  poisonEvidenceOutstanding?: boolean
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

// Retry transient Defender locks/timeouts across launches; cap at three to stop rewalking permanently unwritable Program Files installs.
const MAX_REPAIR_ATTEMPTS = 3

/** Only the locale-independent probe poison signature may trigger repair. */
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
    return null
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

// Failures spend retry budget too; update/reinstall changes the key.
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
      // Attempt per-file grants even after root failure: they can still unblock shipped modules.
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

// Latch per process despite window reopen; ordinary install DACL is stable within a session.
let repairStarted = false

export function resetWindowsInstallDirAclRepairForTest(): void {
  repairStarted = false
}

/** Defer Windows desktop writes; never throw into window creation. Return whether dispatched so process-latch refusals cannot leave callers awaiting onDone. */
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
