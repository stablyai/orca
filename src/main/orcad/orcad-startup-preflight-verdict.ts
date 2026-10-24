/**
 * A managed slot's passed startup preflight, so its disposable second Node process runs once per
 * install instead of on every start (MEASURED 0.25–1.0 s per orcad start on WSL hosts). The verdict
 * is bound to a stat fingerprint of everything the preflight qualified: the installed artifacts, the
 * Node runtime, the OS release, the temp directory it writes to and, on Linux, the shared-library
 * cache the native modules load through. Any input it cannot read means "unknown": probe.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, readFileSync, unlinkSync } from 'node:fs'
import { access, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME
} from '../../shared/orcad-artifacts'
import { listOrcadArtifactFiles } from './orcad-artifact-identity'
import { resolveBundledOrcadSlot } from './orcad-bundled-runtime'

export const ORCAD_STARTUP_PREFLIGHT_VERDICT_FILENAME = '.orcad-startup-preflight.json'
// Bump whenever the preflight or the fingerprint gains a check, so old verdicts stop matching.
const VERDICT_FORMAT = 3
const PENDING_SUFFIX = '.pending'
// Identifies this process's skip claim, so it never settles or clears another start's.
const START_TOKEN = randomUUID()
let skippedThisStart = false

const verdictSchema = z.object({
  format: z.literal(VERDICT_FORMAT),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  artifactVersion: z.string().min(1),
  runtimeVersion: z.string().min(1)
})
export type OrcadStartupPreflightVerdict = z.infer<typeof verdictSchema>

export type StartupPreflightRuntime = {
  execPath: string
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
  osRelease: string
  tempDirectory: string
  /** Linux only. */
  libraryCache: string
}

function currentRuntime(): StartupPreflightRuntime {
  return {
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    tempDirectory: tmpdir(),
    libraryCache: '/etc/ld.so.cache'
  }
}

/** Only a client-managed slot (SSH or WSL); a packaged app directory keeps preflighting every start. */
export function startupPreflightVerdictPath(
  slotDirectory: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
    ? join(slotDirectory, ORCAD_STARTUP_PREFLIGHT_VERDICT_FILENAME)
    : null
}

async function statPart(label: string, path: string): Promise<string> {
  const s = await stat(path)
  return `${label}:${s.size}:${s.mtimeMs}:${s.ino}:${s.dev}`
}

/** Null when any input is unreadable or unknown: never skip a preflight on a partial fingerprint. */
export async function computeStartupPreflightFingerprint(
  slotDirectory: string,
  runtime: StartupPreflightRuntime = currentRuntime()
): Promise<string | null> {
  try {
    const files = new Set([
      ...(await listOrcadArtifactFiles(slotDirectory)),
      ORCAD_VERSION_FILENAME,
      ORCAD_SERVER_TARGET_FILENAME,
      ORCAD_MOBILE_WEB_MANIFEST
    ])
    const parts = [`format:${VERDICT_FORMAT}`]
    for (const file of [...files].sort()) {
      parts.push(await statPart(file, join(slotDirectory, file)))
    }
    parts.push(await statPart(`node:${runtime.execPath}`, runtime.execPath))
    parts.push(`runtime:${runtime.nodeVersion}:${runtime.platform}:${runtime.arch}`)
    // An OS update can change the libraries native modules load on any platform.
    parts.push(`os:${runtime.osRelease}`)
    // The probe writes its disposable database here; an unwritable temp directory must re-probe.
    // Not its mtime: every file created in it, the probe's own included, changes that.
    await access(runtime.tempDirectory, constants.W_OK)
    const temp = await stat(runtime.tempDirectory)
    parts.push(`tmp:${runtime.tempDirectory}:${temp.ino}:${temp.dev}`)
    if (runtime.platform === 'linux') {
      // Contents, not stat: WSL rewrites this cache on every boot. Absent (musl) is unknown: probe.
      const cache = await readFile(runtime.libraryCache)
      parts.push(`ld.so.cache:${createHash('sha256').update(cache).digest('hex')}`)
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex')
  } catch {
    return null
  }
}

export async function readStartupPreflightVerdict(
  path: string
): Promise<OrcadStartupPreflightVerdict | null> {
  try {
    return verdictSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

/** Atomic, so a concurrent start never reads half a verdict; best effort by design. */
export async function writeStartupPreflightVerdict(
  path: string,
  verdict: Omit<OrcadStartupPreflightVerdict, 'format'>
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ format: VERDICT_FORMAT, ...verdict }), {
      mode: 0o600
    })
    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => {})
  }
}

function readClaim(path: string): { pid: number; token: string } | null {
  try {
    const [pid, token] = readFileSync(path + PENDING_SUFFIX, 'utf8')
      .trim()
      .split(' ')
    const parsed = Number(pid)
    return Number.isSafeInteger(parsed) && token ? { pid: parsed, token } : null
  } catch {
    return null
  }
}

function isOwnClaim(path: string): boolean {
  return readClaim(path)?.token === START_TOKEN
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive under another account.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** Drops the verdict and this start's own claim; another start's claim is never touched. */
export async function forgetStartupPreflightVerdict(path: string | null): Promise<void> {
  if (!path) {
    return
  }
  await unlink(path).catch(() => {})
  if (isOwnClaim(path)) {
    await unlink(path + PENDING_SUFFIX).catch(() => {})
  }
}

/** For the exit path: a start that failed after a skipped preflight must preflight next time. */
export function forgetStartupPreflightVerdictSync(path: string | null): void {
  if (!path) {
    return
  }
  try {
    unlinkSync(path)
  } catch {
    // Absent or unwritable: the next start compares the fingerprint anyway.
  }
  if (isOwnClaim(path)) {
    try {
      unlinkSync(path + PENDING_SUFFIX)
    } catch {
      // Already gone.
    }
  }
}

/**
 * After a passed probe: a claim whose start died never settles, and would make every later start
 * probe. A live start's claim stays, so its own crash still forces the next probe.
 */
export async function clearAbandonedStartupPreflightClaim(path: string): Promise<void> {
  const claim = readClaim(path)
  if (claim && claim.token !== START_TOKEN && !isLiveProcess(claim.pid)) {
    await unlink(path + PENDING_SUFFIX).catch(() => {})
  }
}

/** The running slot's verdict, for exit paths that have no slot directory in hand. */
export function forgetSlotStartupPreflightVerdict(
  resolveSlot: () => string = () => resolveBundledOrcadSlot()
): void {
  try {
    forgetStartupPreflightVerdictSync(startupPreflightVerdictPath(resolveSlot()))
  } catch {
    // An unresolvable slot never wrote a verdict.
  }
}

/**
 * Claims a skip for this start, atomically. A start that dies before readiness (a crash, a signal)
 * never runs the failure path, so its claim survives and the next start probes instead.
 */
export async function claimStartupPreflightSkip(path: string): Promise<boolean> {
  try {
    await writeFile(path + PENDING_SUFFIX, `${process.pid} ${START_TOKEN}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
    skippedThisStart = true
    return true
  } catch {
    return false
  }
}

/** True once this process skipped its probe on a verdict; the import guard then re-qualifies it. */
export function wasStartupPreflightSkipped(): boolean {
  return skippedThisStart
}

/** Readiness published: the skipped preflight's verdict held for this start. */
export function settleSlotStartupPreflightSkip(
  resolveSlot: () => string = () => resolveBundledOrcadSlot()
): void {
  try {
    const path = startupPreflightVerdictPath(resolveSlot())
    if (path && isOwnClaim(path)) {
      unlinkSync(path + PENDING_SUFFIX)
    }
  } catch {
    // No skip was claimed, or the slot is unresolvable.
  }
}
