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

/**
 * Codex's hash per event it lists Orca's entry in; null for a listed event on a
 * Codex with no hook approvals (before 0.129). An unlisted event gets no entry.
 */
export type CodexHookHashes = Readonly<Partial<Record<CodexEventLabel, string | null>>>

/** What Codex said about Orca's entry. */
export type CodexHookAnswer =
  | { kind: 'hashes'; codexVersion: string; hashes: CodexHookHashes }
  /** Codex answered, and its answer cannot approve Orca's entry: too old, unrecognized, inconsistent. */
  | { kind: 'refused'; codexVersion: string; failure: string }
  /** No answer yet (not asked, not found, or Codex failed before answering); asking again may get one. */
  | { kind: 'pending'; failure: string; codexMissing?: true }

// Why this long off the launch path: macOS assesses a new codex on its first run, measured at 10-12 s.
const VERSION_TIMEOUT_MS = 30_000
// Why: an app-server start with a cold sqlite takes ~4 s; this bounds a hung binary.
const DERIVE_TIMEOUT_MS = 30_000
// Why a second group: the copy after it shows whether Codex's hash depends on position.
const SCRATCH_DUMMY_HOOK = { type: 'command', command: 'exit 0' }
const SCRATCH_ORCA_GROUP_INDEXES = [0, 2] as const
const SCRATCH_DUMMY_GROUP_INDEX = 1
const SCRATCH_PREFIXES = ['orca-codex-hook-trust-', 'orca-codex-version-'] as const
// Why an hour: no ask lives that long, so an older scratch home is one a quit left behind.
const STALE_SCRATCH_MS = 60 * 60_000

type CodexHookScratchListing = {
  listings: CodexListedHook[]
  homeHooksPath: string
  projectHooksPath: string
}

/**
 * Asks one Codex binary for its hash of Orca's entry in each event, from a
 * throwaway CODEX_HOME. The same entry is listed at group 0, after another
 * group, and from a trusted project folder; Codex must hash all three alike,
 * so the answer holds for every home. Never throws; never reads or writes a real home.
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
      // Why once more: the copies come from different config layers, so confirm before refusing.
      hashes = readCodexHookHashes(await listScratchHomeHooks(codexPath, hookCommand), hookCommand)
    }
    if (hashes === 'inconsistent') {
      return refused(
        `${describeCodexVersion(codexVersion)} hashes Orca's status hook differently by its file or position, so Orca does not approve it`
      )
    }
    if (hashes === 'unloaded') {
      // Why pending: an empty or reshaped answer says nothing about this version.
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
    // Why pending: a crash, timeout or RPC error says nothing about the version, so it must not be saved for it.
    return { kind: 'pending', failure: error instanceof Error ? error.message : String(error) }
  }
}

/** Orca's entry in every event: alone in group 0 and, with `positionCopy`, again after a dummy group. */
export function buildScratchHooksJson(hookCommand: string, positionCopy: boolean): string {
  const hooks = Object.fromEntries(
    CODEX_EVENTS.map((eventName) => {
      const orca = { hooks: [buildCodexManagedHook(hookCommand, eventName)] }
      return [eventName, positionCopy ? [orca, { hooks: [SCRATCH_DUMMY_HOOK] }, orca] : [orca]]
    })
  )
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/** `hooks/list` for `codexHome`, or the default home when it is null; it changes no hook or config file. */
export async function listCodexHooks(
  codexPath: string,
  codexHome: string | null,
  cwd: string
): Promise<CodexListedHook[]> {
  const result = await runCodexAppServerSession(
    {
      command: codexPath,
      // Why the probe args: plugin startup can leave marketplace clones behind a short session.
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
    // Why resolved: Codex keys hooks and project trust by the real path (macOS /var is /private/var).
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
 * Codex's hash per event it lists Orca's scratch entry at group 0 for;
 * 'inconsistent' when a copy elsewhere hashes differently; null when Codex
 * loaded the scratch home (its dummy hook is listed) but none of Orca's
 * entries; 'unloaded' when it listed neither. Only the scratch files count.
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
  // Why drop hash-less events when others have one: on a Codex with approvals they would wait for review.
  return Object.values(hashes).some((hash) => hash !== null)
    ? Object.fromEntries(Object.entries(hashes).filter(([, hash]) => hash !== null))
    : hashes
}

/** "Codex 0.150.1" for `codex --version`'s "codex-cli 0.150.1"; other output as it is. */
function describeCodexVersion(codexVersion: string): string {
  return codexVersion.replace(/^codex-cli\s+/, 'Codex ')
}

// Why these fields: they change when an update or reinstall replaces the binary behind the path.
/** The identity of the binary at `codexPath` as it is on disk now; null when there is none. */
export function fingerprintCodex(codexPath: string): string | null {
  try {
    const realPath = realpathSync(codexPath)
    const info = statSync(realPath)
    return `${realPath}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return null
  }
}

/** `codex --version`'s output; null when it reports none. */
export async function probeCodexVersion(codexCommand: string): Promise<string | null> {
  // Why a throwaway home: even `--version` leaves a tmp/arg0 folder in its CODEX_HOME.
  const scratchHome = await mkdtemp(join(tmpdir(), SCRATCH_PREFIXES[1]))
  try {
    const result = await runProcess({
      program: codexCommand,
      args: ['--version'],
      env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: scratchHome }),
      timeoutMs: VERSION_TIMEOUT_MS,
      // Why the tree: a hung Windows wrapper's codex child would outlive a root-only kill.
      terminationBarrier: true
    })
    return (result.code === 0 && result.stdout.trim()) || null
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

/** Removes the scratch homes an earlier process left when it quit mid-ask. Never throws. */
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
