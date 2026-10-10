import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { getIcaclsExePath } from '../win32-utils'

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

const PROBE_BUDGET_MS = 5_000

// Why SDDL (`icacls /save`) rather than icacls's display: the display localizes
// the well-known package names — and on zh/ja/ko even keeps "NT AUTHORITY" English
// while doing so — so a repaired tree read as poisoned. SDDL prints SIDs on every locale.
const PACKAGE_SID = /^S-1-15-2-[0-9-]+$/i
/** ALL RESTRICTED APPLICATION PACKAGES: the grant the reproduced remedy added. */
const RESTRICTED_PACKAGES_SID = 'S-1-15-2-2'
/** `AC` is SDDL's alias for ALL APPLICATION PACKAGES (S-1-15-2-1). */
const WELL_KNOWN_PACKAGE_SIDS = new Set(['AC', 'S-1-15-2-1', RESTRICTED_PACKAGES_SID])
/** (type;flags;rights;object;inheritedObject;sid[;condition]) */
const SDDL_ACE = /\(([A-Z]+);([A-Z]*);[^;()]*;[^;()]*;[^;()]*;([^;()]+)[;)]/gi

export type WindowsInstallDirAclProbeOptions = {
  platform?: NodeJS.Platform
  isServeMode?: boolean
  installDir?: string
  /** Test seams. */
  spawnFn?: typeof spawn
  fileExists?: (path: string) => boolean
  recordBreadcrumb?: typeof recordDurableCrashBreadcrumb
  onDone?: (data: CrashReportBreadcrumbData) => void
}

type AclFacts = {
  orphanPackageSids: string[]
  hasWellKnownPackageGrant: boolean
  hasRestrictedPackageGrant: boolean
}

function readSavedDacl(spawnFn: typeof spawn, target: string, deadlineMs: number): Promise<string> {
  const saveFile = join(tmpdir(), `orca-install-acl-${randomUUID()}.txt`)
  return new Promise<string>((resolve) => {
    // /save only reads the target (it writes the temp file). Never /T — a recursive
    // walk on a real profile measured 62s and timed out (see windows-user-data-acl.ts).
    const child = spawnFn(getIcaclsExePath(), [target, '/save', saveFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    })
    let settled = false
    const settle = (read: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      let out = ''
      try {
        // An empty read parses as a clean DACL, so a failed /save must stay ''.
        out = read ? readFileSync(saveFile, 'utf16le') : ''
      } catch {
        out = ''
      }
      try {
        // A killed icacls may still hold the file; a leftover temp file is harmless.
        rmSync(saveFile, { force: true })
      } catch {
        // Nothing to do.
      }
      resolve(out)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(false)
    }, deadlineMs)
    timer.unref?.()
    child.on('error', () => settle(false))
    child.on('close', (code) => settle(code === 0))
  })
}

function collectAclFacts(savedDacl: string): AclFacts | null {
  const orphanPackageSids: string[] = []
  let hasWellKnownPackageGrant = false
  let hasRestrictedPackageGrant = false
  // A partial DACL can hide a later grant; unsupported ACEs must stay unreadable.
  const dacl = /^D:[A-Z]*((?:\([^()]*\))*)(?:S:.*)?$/im.exec(savedDacl)
  if (!dacl) {
    return null
  }
  for (const [, type, flags, rawSid] of dacl[1].matchAll(SDDL_ACE)) {
    const sid = rawSid.toUpperCase()
    if (!WELL_KNOWN_PACKAGE_SIDS.has(sid)) {
      if (PACKAGE_SID.test(sid)) {
        orphanPackageSids.push(rawSid)
      }
      continue
    }
    // Why: an ACE that denies, or only propagates to children (IO), grants nothing
    // on this object — so it cannot satisfy an orphan the way the reproduced fix did.
    const flagTokens: string[] = flags.toUpperCase().match(/../g) ?? []
    const inheritOnly = flagTokens.includes('IO')
    if (type.toUpperCase() !== 'A' || inheritOnly) {
      continue
    }
    hasWellKnownPackageGrant = true
    // Reported, never the verdict: narrows which grant is present for triage.
    if (sid === RESTRICTED_PACKAGES_SID) {
      hasRestrictedPackageGrant = true
    }
  }
  return { orphanPackageSids, hasWellKnownPackageGrant, hasRestrictedPackageGrant }
}

function resolveTargets(installDir: string, fileExists: (path: string) => boolean): string[] {
  const moduleFile = MODULE_SHORTLIST.map((name) => join(installDir, name)).find(fileExists)
  return moduleFile ? [installDir, moduleFile] : [installDir]
}

async function runProbe(options: WindowsInstallDirAclProbeOptions): Promise<void> {
  const record = options.recordBreadcrumb ?? recordDurableCrashBreadcrumb
  let data: CrashReportBreadcrumbData
  try {
    const installDir = options.installDir ?? dirname(process.execPath)
    const targets = resolveTargets(installDir, options.fileExists ?? existsSync)
    const spawnFn = options.spawnFn ?? spawn
    const startedAt = Date.now()
    const outputs: string[] = []
    for (const target of targets) {
      const remaining = PROBE_BUDGET_MS - (Date.now() - startedAt)
      // Why one shared budget: two targets must never cost two full timeouts.
      outputs.push(remaining > 0 ? await readSavedDacl(spawnFn, target, remaining) : '')
    }
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
 * Fire-and-forget; returns before any spawn. win32 only — no spawn and no fs I/O
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
      void runProbe(options).catch(() => undefined)
    })
  } catch {
    // Nothing left to report to that would not throw again.
  }
  return true
}
