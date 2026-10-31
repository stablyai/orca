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

/** Read-only evidence for electron/electron#51761: orphan package ACEs without either well-known package grant reproduced child-init 0x80000003. Either grant launched clean on Windows 10.0.26200/Electron 43.4.1; report restricted-grant presence separately. */

export const WINDOWS_INSTALL_DIR_ACL_BREADCRUMB = 'windows_install_dir_acl'

// Probe a shipped module too: directory DACL cannot establish per-file read access.
const MODULE_SHORTLIST = ['ffmpeg.dll', 'libGLESv2.dll', 'libEGL.dll', 'icudtl.dat']

// Use raw SIDs: localized package display names previously misclassified repaired trees.
const PACKAGE_SID = /^S-1-15-2-[0-9-]+$/i
/** ALL APPLICATION PACKAGES and ALL RESTRICTED APPLICATION PACKAGES. */
const WELL_KNOWN_PACKAGE_SIDS = new Set(['S-1-15-2-1', RESTRICTED_APP_PACKAGES_SID])

export type WindowsInstallDirAclProbeOptions = {
  platform?: NodeJS.Platform
  isServeMode?: boolean
  installDir?: string
  fileExists?: (path: string) => boolean
  recordBreadcrumb?: typeof recordDurableCrashBreadcrumb
  onDone?: (data: CrashReportBreadcrumbData) => void
}

type AclFacts = {
  orphanPackageSids: string[]
  hasWellKnownPackageGrant: boolean
  hasRestrictedPackageGrant: boolean
}

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
  // Unreadable/NULL/unsupported ACEs yield no facts; a skipped ACE might be the satisfying grant.
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
    // Deny and inherit-only ACEs grant no access to this object.
    if (ace.type !== ACCESS_ALLOWED_ACE_TYPE || (ace.flags & INHERIT_ONLY_ACE) !== 0) {
      continue
    }
    hasWellKnownPackageGrant = true
    // Restricted-grant presence narrows diagnostics but does not decide poison.
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
    // Judge each target separately or a directory grant could hide a poisoned module.
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
            // Cap orphan identity evidence while retaining cross-report correlation.
            orphanPackageSids: sanitizeCrashReportString(orphans.slice(0, 3).join(','), 200),
            // Either well-known grant satisfies the orphan for this verdict.
            hasWellKnownPackageGrant,
            // Diagnostic only: the -1-only shape launched clean on hardware.
            hasRestrictedPackageGrant,
            matchesPoisonSignature: poisoned
          }
  } catch (error) {
    data = { status: 'failed', reason: sanitizeCrashReportString(`probe: ${String(error)}`, 200) }
  }
  record(WINDOWS_INSTALL_DIR_ACL_BREADCRUMB, data)
  options.onDone?.(data)
}

// Probe once per process despite window reopen; ordinary install DACL is stable within a session.
let probeStarted = false

export function resetWindowsInstallDirAclProbeForTest(): void {
  probeStarted = false
}

/** Defer Windows-only reads until after window creation; observability is ready. Return whether dispatched so reopen callers cannot await an onDone the process latch prevents. */
export function probeWindowsInstallDirAcl(options: WindowsInstallDirAclProbeOptions = {}): boolean {
  if ((options.platform ?? process.platform) !== 'win32' || options.isServeMode === true) {
    return false
  }
  if (probeStarted) {
    return false
  }
  probeStarted = true
  // Probe scheduling runs inline with window creation; diagnostic failures must not escape.
  try {
    setImmediate(() => {
      try {
        runProbe(options)
      } catch {
        // Fail quietly if the diagnostic recorder/callback itself throws.
      }
    })
  } catch {
    // No remaining recorder can safely report this failure.
  }
  return true
}
