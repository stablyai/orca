import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { loadWindowsSecurity, type WindowsDacl } from '../../shared/windows-security-addon'
import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  INHERIT_ONLY_ACE
} from '../../shared/windows-secure-dacl'
import { RESTRICTED_APP_PACKAGES_SID } from './windows-install-dir-package-acl-grant'

/**
 * Read-only DACL probe for the win32 install directory.
 *
 * Why: six 1.4.184 reports show the GPU and renderer children both dying at init
 * with 0x80000003 and nothing to distinguish them from any other CHECK. An install
 * tree carrying an orphan S-1-15-2-* package ACE with no S-1-15-2-1/-2 to satisfy
 * it reproduces exactly that signature (10/10 launches), and an additive grant of
 * S-1-15-2-2 clears it — see electron/electron#51761. This records whether a
 * machine is in that state so the next crash report answers the question itself.
 *
 * The verdict deliberately accepts EITHER well-known grant: a tree carrying the
 * orphan plus S-1-15-2-1 only (the Program Files default) launched clean on
 * win32 10.0.26200 / Electron 43.4.1, so it is not the reproduced state and must
 * not be treated as one. `hasRestrictedPackageGrant` is still reported, so a
 * report can tell the two shapes apart if that ever stops holding.
 *
 * Diagnostic only: it never writes an ACL and never changes behavior.
 */

export const WINDOWS_INSTALL_DIR_ACL_BREADCRUMB = 'windows_install_dir_acl'

// Why a shortlist rather than a readdir: the reproduced failure is a per-file
// content read, so the directory's own DACL is not sufficient evidence — but any
// one shipped module answers it, and existsSync costs nothing.
const MODULE_SHORTLIST = ['ffmpeg.dll', 'libGLESv2.dll', 'libEGL.dll', 'icudtl.dat']

// Why raw SIDs rather than a display listing: displays localize the well-known package
// names — and on zh/ja/ko even keep "NT AUTHORITY" English while doing so — so a
// repaired tree read as poisoned. A SID reads the same on every locale.
const PACKAGE_SID = /^S-1-15-2-[0-9-]+$/i
/** ALL APPLICATION PACKAGES and ALL RESTRICTED APPLICATION PACKAGES. */
const WELL_KNOWN_PACKAGE_SIDS = new Set(['S-1-15-2-1', RESTRICTED_APP_PACKAGES_SID])

export type WindowsInstallDirAclProbeOptions = {
  platform?: NodeJS.Platform
  isServeMode?: boolean
  installDir?: string
  /** Test seams. */
  fileExists?: (path: string) => boolean
  recordBreadcrumb?: typeof recordDurableCrashBreadcrumb
  onDone?: (data: CrashReportBreadcrumbData) => void
}

type AclFacts = {
  orphanPackageSids: string[]
  hasWellKnownPackageGrant: boolean
  hasRestrictedPackageGrant: boolean
}

/** The target's DACL, or null when it cannot be read (an unreadable target stays unreadable). */
function readDacl(target: string): WindowsDacl | null {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    throw new Error(`windows-security addon unavailable: ${security.error}`)
  }
  try {
    return security.addon.getDaclAces(target)
  } catch {
    return null
  }
}

function collectAclFacts(dacl: WindowsDacl | null): AclFacts | null {
  // Fails closed: an unreadable target, a NULL DACL, or any ACE that is not a plain allow/deny
  // gives no facts, since a skipped ACE could be the grant that satisfies an orphan.
  if (
    !dacl ||
    dacl.aces.some(
      (ace) => ace.type !== ACCESS_ALLOWED_ACE_TYPE && ace.type !== ACCESS_DENIED_ACE_TYPE
    )
  ) {
    return null
  }
  const orphanPackageSids: string[] = []
  let hasWellKnownPackageGrant = false
  let hasRestrictedPackageGrant = false
  for (const ace of dacl.aces) {
    const sid = ace.sid ?? ''
    if (!WELL_KNOWN_PACKAGE_SIDS.has(sid)) {
      if (PACKAGE_SID.test(sid)) {
        orphanPackageSids.push(sid)
      }
      continue
    }
    // Why: an ACE that denies, or only propagates to children (IO), grants nothing
    // on this object — so it cannot satisfy an orphan the way the reproduced fix did.
    if (ace.type !== ACCESS_ALLOWED_ACE_TYPE || (ace.flags & INHERIT_ONLY_ACE) !== 0) {
      continue
    }
    hasWellKnownPackageGrant = true
    // Reported, never the verdict: narrows which grant is present for triage.
    if (sid === RESTRICTED_APP_PACKAGES_SID) {
      hasRestrictedPackageGrant = true
    }
  }
  return { orphanPackageSids, hasWellKnownPackageGrant, hasRestrictedPackageGrant }
}

function resolveTargets(installDir: string, fileExists: (path: string) => boolean): string[] {
  const moduleFile = MODULE_SHORTLIST.map((name) => join(installDir, name)).find(fileExists)
  return moduleFile ? [installDir, moduleFile] : [installDir]
}

function runProbe(options: WindowsInstallDirAclProbeOptions): void {
  const record = options.recordBreadcrumb ?? recordDurableCrashBreadcrumb
  let data: CrashReportBreadcrumbData
  try {
    const installDir = options.installDir ?? dirname(process.execPath)
    const targets = resolveTargets(installDir, options.fileExists ?? existsSync)
    const outputs = targets.map(readDacl)
    const facts = outputs.map(collectAclFacts).filter((fact) => fact !== null)
    const orphans = [...new Set(facts.flatMap((f) => f.orphanPackageSids))]
    const hasWellKnownPackageGrant = facts.some((f) => f.hasWellKnownPackageGrant)
    const hasRestrictedPackageGrant = facts.some((f) => f.hasRestrictedPackageGrant)
    // Why per target: a grant on the directory does not grant on the module file,
    // and the reproduced failure is a per-file content read. Merging would let a
    // grant on one target mask its absence on the other.
    const poisoned = facts.some(
      (f) => f.orphanPackageSids.length > 0 && !f.hasWellKnownPackageGrant
    )
    data =
      facts.length === 0
        ? { status: 'failed', reason: 'all-targets-unreadable' }
        : {
            status: 'ok',
            probedTargetCount: targets.length,
            orphanPackageSidCount: orphans.length,
            // Capped: correlating the same orphan across reports is what would
            // identify the tool that left it, which is the point of recording it.
            orphanPackageSids: sanitizeCrashReportString(orphans.slice(0, 3).join(','), 200),
            // The verdict rides on this one: either well-known grant satisfies the orphan.
            hasWellKnownPackageGrant,
            // Diagnostic only — the -1-only shape launches clean on real hardware.
            hasRestrictedPackageGrant,
            matchesPoisonSignature: poisoned
          }
  } catch (error) {
    data = { status: 'failed', reason: sanitizeCrashReportString(`probe: ${String(error)}`, 200) }
  }
  record(WINDOWS_INSTALL_DIR_ACL_BREADCRUMB, data)
  options.onDone?.(data)
}

// Why once per process: the install DACL cannot usefully change mid-session, and
// openMainWindow re-runs on re-activation.
let probeStarted = false

export function resetWindowsInstallDirAclProbeForTest(): void {
  probeStarted = false
}

/**
 * Fire-and-forget; returns before any read. win32 only — no ACL read and no fs I/O
 * anywhere else. Called from openMainWindow, which runs after initObservability,
 * so the durable record also emits a span into the diagnostics bundle.
 *
 * Returns whether THIS call dispatched the probe: openMainWindow re-runs on every
 * reopen, and only a dispatch will ever produce an `onDone`.
 */
export function probeWindowsInstallDirAcl(options: WindowsInstallDirAclProbeOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== 'win32' || options.isServeMode === true) {
    return false
  }
  if (probeStarted) {
    return false
  }
  probeStarted = true
  // Why the try: this runs inline in openMainWindow, so anything thrown here
  // propagates into window creation. A diagnostic must never be able to do that.
  try {
    setImmediate(() => {
      try {
        runProbe(options)
      } catch {
        // A diagnostic, and a throwing recorder or onDone has nowhere left to report.
      }
    })
  } catch {
    // Nothing left to report to that would not throw again.
  }
  return true
}
