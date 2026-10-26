import { realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../codex-cli/command'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { collectListedHooks, type CodexListedHook } from './codex-app-server-client'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession
} from './codex-app-server-session'
import { buildCodexManagedHook, CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import {
  normalizeHookTrustKeyForLookup,
  upsertProjectTrustLevelInContent,
  type CodexEventLabel
} from './config-toml-trust'

/** Absent: unlisted event; null: listed by pre-0.129 Codex without hook approvals. */
export type CodexHookHashes = Readonly<Partial<Record<CodexEventLabel, string | null>>>

export type CodexHookAnswer =
  | { kind: 'hashes'; codexVersion: string; hashes: CodexHookHashes }
  /** Definitive rejection: too old, unrecognized or inconsistent. */
  | { kind: 'refused'; codexVersion: string; failure: string }
  /** No definitive answer; retrying may succeed. */
  | { kind: 'pending'; failure: string; codexMissing?: true }

// Allow macOS first-run assessment, measured at 10–12s, off the launch path.
const VERSION_TIMEOUT_MS = 30_000
// Allow cold SQLite startup (~4s) while bounding hung binaries.
const DERIVE_TIMEOUT_MS = 30_000
// Shift a copy to verify that Codex hashes do not depend on position.
const SCRATCH_DUMMY_HOOK = { type: 'command', command: 'exit 0' }
const SCRATCH_ORCA_GROUP_INDEXES = [0, 2] as const
const SCRATCH_DUMMY_GROUP_INDEX = 1
const SCRATCH_PREFIXES = ['orca-codex-hook-trust-', 'orca-codex-version-'] as const
// An hour exceeds any probe's lifetime; older scratch homes were abandoned.
const STALE_SCRATCH_MS = 60 * 60_000

type CodexHookScratchListing = {
  listings: CodexListedHook[]
  homeHooksPath: string
  projectHooksPath: string
}

/**
 * Verify position/file-independent hashes using a disposable home and trusted project.
 * Failures become answers; real homes are never read or written.
 */
export async function deriveCodexHookHashes(
  codexPath: string,
  hookCommand: string,
  codexVersion: string
): Promise<CodexHookAnswer> {
  const refused = (failure: string): CodexHookAnswer => ({ kind: 'refused', codexVersion, failure })
  try {
    let hashes = readCodexHookHashes(
      await listScratchHomeHooks(codexPath, hookCommand),
      hookCommand
    )
    if (hashes === 'inconsistent') {
      // Confirm cross-layer inconsistency before refusing this version.
      hashes = readCodexHookHashes(await listScratchHomeHooks(codexPath, hookCommand), hookCommand)
    }
    if (hashes === 'inconsistent') {
      return refused(
        `${describeCodexVersion(codexVersion)} hashes Orca's status hook differently by its file or position, so Orca does not approve it`
      )
    }
    if (hashes === 'unloaded') {
      // An unloaded scratch home cannot establish version incompatibility.
      return {
        kind: 'pending',
        failure: `${describeCodexVersion(codexVersion)} listed no hooks from Orca's test home`
      }
    }
    if (!hashes) {
      return refused(`${describeCodexVersion(codexVersion)} did not recognize Orca's status hook`)
    }
    return { kind: 'hashes', codexVersion, hashes }
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      return refused(
        `${describeCodexVersion(codexVersion)} is too old for Orca status; update Codex`
      )
    }
    console.warn('[codex-hook-trust] could not derive Codex hook hashes:', error)
    // Do not persist transient crashes, timeouts or RPC failures as version incompatibility.
    return { kind: 'pending', failure: error instanceof Error ? error.message : String(error) }
  }
}

export function buildScratchHooksJson(hookCommand: string, positionCopy: boolean): string {
  const hooks = Object.fromEntries(
    CODEX_EVENTS.map((eventName) => {
      const orca = { hooks: [buildCodexManagedHook(hookCommand, eventName)] }
      return [eventName, positionCopy ? [orca, { hooks: [SCRATCH_DUMMY_HOOK] }, orca] : [orca]]
    })
  )
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/** Null selects the default home; hook and config files remain unchanged. */
export async function listCodexHooks(
  codexPath: string,
  codexHome: string | null,
  cwd: string
): Promise<CodexListedHook[]> {
  const result = await runCodexAppServerSession(
    {
      command: codexPath,
      // Disable plugin startup to avoid leaving marketplace clones behind short sessions.
      args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      cliPath: codexPath,
      ...(codexHome ? { env: { CODEX_HOME: codexHome } } : { envToDelete: ['CODEX_HOME'] }),
      timeoutMs: DERIVE_TIMEOUT_MS
    },
    (rpc) => rpc.request('hooks/list', { cwds: [cwd] })
  )
  return collectListedHooks(result)
}

async function listScratchHomeHooks(
  codexPath: string,
  hookCommand: string
): Promise<CodexHookScratchListing> {
  const root = await mkdtemp(join(tmpdir(), SCRATCH_PREFIXES[0]))
  try {
    // Codex keys hooks/project trust by real paths (macOS /var resolves to /private/var).
    const resolvedRoot = await realpath(root)
    const scratchHome = join(resolvedRoot, 'home')
    const project = join(resolvedRoot, 'project')
    await mkdir(join(project, '.codex'), { recursive: true })
    await mkdir(scratchHome)
    await writeFile(join(scratchHome, 'hooks.json'), buildScratchHooksJson(hookCommand, true))
    await writeFile(
      join(project, '.codex', 'hooks.json'),
      buildScratchHooksJson(hookCommand, false)
    )
    await writeFile(
      join(scratchHome, 'config.toml'),
      upsertProjectTrustLevelInContent('', project, 'trusted')
    )
    return {
      listings: await listCodexHooks(codexPath, scratchHome, project),
      homeHooksPath: join(scratchHome, 'hooks.json'),
      projectHooksPath: join(project, '.codex', 'hooks.json')
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/**
 * 'inconsistent': copies hash differently; null: dummy listed without Orca; 'unloaded': neither listed.
 * Only scratch files count; absent events stay absent.
 */
export function readCodexHookHashes(
  scratch: CodexHookScratchListing,
  hookCommand: string
): CodexHookHashes | 'inconsistent' | 'unloaded' | null {
  const byKey = new Map(
    scratch.listings.map((listing) => [normalizeHookTrustKeyForLookup(listing.key), listing])
  )
  const listedCommand = (
    command: string,
    sourcePath: string,
    label: CodexEventLabel,
    groupIndex: number
  ) => {
    const listing = byKey.get(
      normalizeHookTrustKeyForLookup(`${sourcePath}:${label}:${groupIndex}:0`)
    )
    return listing?.command === command ? listing : undefined
  }
  const listed = (sourcePath: string, label: CodexEventLabel, groupIndex: number) =>
    listedCommand(hookCommand, sourcePath, label, groupIndex)
  const hashes: Partial<Record<CodexEventLabel, string | null>> = {}
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const primary = listed(scratch.homeHooksPath, label, SCRATCH_ORCA_GROUP_INDEXES[0])
    if (!primary) {
      continue
    }
    const copies = [
      listed(scratch.homeHooksPath, label, SCRATCH_ORCA_GROUP_INDEXES[1]),
      listed(scratch.projectHooksPath, label, 0)
    ]
    if (copies.some((copy) => copy && copy.currentHash !== primary.currentHash)) {
      return 'inconsistent'
    }
    hashes[label] = primary.currentHash
  }
  const labels = Object.keys(hashes)
  if (labels.length === 0) {
    const loaded = CODEX_EVENTS.some((eventName) =>
      listedCommand(
        SCRATCH_DUMMY_HOOK.command,
        scratch.homeHooksPath,
        CODEX_EVENT_LABEL[eventName],
        SCRATCH_DUMMY_GROUP_INDEX
      )
    )
    return loaded ? null : 'unloaded'
  }
  // On Codex with approvals, hashless events would wait for review.
  return Object.values(hashes).some((hash) => hash !== null)
    ? Object.fromEntries(Object.entries(hashes).filter(([, hash]) => hash !== null))
    : hashes
}

function describeCodexVersion(codexVersion: string): string {
  return codexVersion.replace(/^codex-cli\s+/, 'Codex ')
}

// Detect binary replacement by updates/reinstalls, including equal-size atomic replacements via inode.
export function fingerprintCodex(codexPath: string): string | null {
  try {
    const realPath = realpathSync(codexPath)
    const info = statSync(realPath)
    return `${realPath}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return null
  }
}

export async function probeCodexVersion(codexCommand: string): Promise<string | null> {
  // Even --version creates tmp/arg0 in CODEX_HOME; isolate it from real homes.
  const scratchHome = await mkdtemp(join(tmpdir(), SCRATCH_PREFIXES[1]))
  try {
    const result = await runProcess({
      program: codexCommand,
      args: ['--version'],
      env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: scratchHome }),
      timeoutMs: VERSION_TIMEOUT_MS,
      // A hung Windows wrapper's Codex child would survive a root-only kill.
      terminationBarrier: true
    })
    return (result.code === 0 && result.stdout.trim()) || null
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

export async function sweepStaleCodexScratchHomes(): Promise<void> {
  const root = tmpdir()
  const names = await readdir(root).catch(() => [])
  for (const name of names.filter((n) => SCRATCH_PREFIXES.some((p) => n.startsWith(p)))) {
    const path = join(root, name)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > STALE_SCRATCH_MS) {
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }
}
