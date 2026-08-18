import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
 * Diagnostic only: it never writes an ACL and never changes behavior.
 */

export const WINDOWS_INSTALL_DIR_ACL_BREADCRUMB = 'windows_install_dir_acl'

// Why a shortlist rather than a readdir: the reproduced failure is a per-file
// content read, so the directory's own DACL is not sufficient evidence — but any
// one shipped module answers it, and existsSync costs nothing.
const MODULE_SHORTLIST = ['ffmpeg.dll', 'libGLESv2.dll', 'libEGL.dll', 'icudtl.dat']

const PROBE_BUDGET_MS = 5_000

/** Raw S-1-15-2-* means icacls could not resolve it — locale-independent. */
const RAW_PACKAGE_SID = /\bS-1-15-2-[0-9-]+\b/i
const WELL_KNOWN_PACKAGE_SIDS = new Set(['s-1-15-2-1', 's-1-15-2-2'])
// icacls localizes these; the raw SID form is never printed for them. Orphan
// detection stays SID-form and locale-independent, but this check is not — so we
// report whether the output looked English at all, making a locale-induced
// false positive recognizable instead of silent.
const WELL_KNOWN_PACKAGE_NAMES = /ALL (RESTRICTED )?APPLICATION PACKAGES/i
const ENGLISH_PRINCIPAL = /\b(NT AUTHORITY|BUILTIN|APPLICATION PACKAGE AUTHORITY)\b/i
// Why: an ACE that denies, or only propagates to children, grants nothing on this
// object — so it cannot satisfy an orphan the way the reproduced fix did.
const NON_GRANTING_FLAGS = /\((?:DENY|IO)\)/i

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
  sawEnglishPrincipal: boolean
}

function readDacl(spawnFn: typeof spawn, target: string, deadlineMs: number): Promise<string> {
  return new Promise((resolve) => {
    // No flags: icacls with a bare path only reads. Never /T — a recursive walk on
    // a real profile measured 62s and timed out (see windows-user-data-acl.ts).
    const child = spawnFn(getIcaclsExePath(), [target], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    let settled = false
    const settle = (value: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      settle('')
    }, deadlineMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.on('error', () => settle(''))
    // 'close' not 'exit': exit can fire before stdout drains, and an empty read
    // would parse as a clean DACL — a false negative in the only case we care about.
    child.on('close', () => settle(out))
  })
}

function collectAclFacts(daclOutput: string): AclFacts {
  const orphanPackageSids: string[] = []
  let hasWellKnownPackageGrant = false
  let sawEnglishPrincipal = false
  for (const line of daclOutput.split(/\r?\n/)) {
    if (ENGLISH_PRINCIPAL.test(line)) {
      sawEnglishPrincipal = true
    }
    // icacls glues the echoed path onto the first principal with no separator, so
    // match the principal:(flags) tail rather than trying to split the line.
    const ace = /([^\s:][^:]*):(\([^\s]*\))\s*$/.exec(line.trim())
    if (!ace) {
      continue
    }
    const [, principal, flags] = ace
    const sid = RAW_PACKAGE_SID.exec(principal)?.[0]
    if (sid && !WELL_KNOWN_PACKAGE_SIDS.has(sid.toLowerCase())) {
      orphanPackageSids.push(sid)
      continue
    }
    const isWellKnown = sid !== undefined || WELL_KNOWN_PACKAGE_NAMES.test(principal)
    if (isWellKnown && !NON_GRANTING_FLAGS.test(flags)) {
      hasWellKnownPackageGrant = true
    }
  }
  return { orphanPackageSids, hasWellKnownPackageGrant, sawEnglishPrincipal }
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
      outputs.push(remaining > 0 ? await readDacl(spawnFn, target, remaining) : '')
    }
    const facts = outputs.map(collectAclFacts)
    const orphans = [...new Set(facts.flatMap((f) => f.orphanPackageSids))]
    const hasWellKnownPackageGrant = facts.some((f) => f.hasWellKnownPackageGrant)
    // Why per target: a grant on the directory does not grant on the module file,
    // and the reproduced failure is a per-file content read. Merging would let a
    // grant on one target mask its absence on the other.
    const poisoned = facts.some(
      (f) => f.orphanPackageSids.length > 0 && !f.hasWellKnownPackageGrant
    )
    data = outputs.every((out) => out === '')
      ? { status: 'failed', reason: 'all-targets-unreadable' }
      : {
          status: 'ok',
          probedTargetCount: targets.length,
          orphanPackageSidCount: orphans.length,
          // Capped: correlating the same orphan across reports is what would
          // identify the tool that left it, which is the point of recording it.
          orphanPackageSids: sanitizeCrashReportString(orphans.slice(0, 3).join(','), 200),
          hasWellKnownPackageGrant,
          // False positives are possible on a non-English Windows, where the
          // well-known ACE resolves to a localized name this cannot match.
          wellKnownNameCheckReliable: facts.some((f) => f.sawEnglishPrincipal),
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
 */
export function probeWindowsInstallDirAcl(options: WindowsInstallDirAclProbeOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'win32' || options.isServeMode === true) {
    return
  }
  if (probeStarted) {
    return
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
}
