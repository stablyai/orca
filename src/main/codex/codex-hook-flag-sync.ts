import { watch as watchFs } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveCodexCommand } from '../codex-cli/command'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getManagedScriptPath } from './codex-hook-definition'
import { getManagedScript } from './codex-hook-script'
import {
  codexHookFlagTableExists,
  createCodexHookFlagTable,
  getCodexHookFlagTablePath,
  pruneCodexHookFlagEntries,
  readCodexHookFlagEntry,
  removeCodexHookFlagTable,
  resolveCodexProbePath,
  takeCodexHookFlagRequests
} from './codex-hook-flag-table'
import { createFolderWatch, type FolderWatch, type WatchFolder } from './codex-folder-watch'
import { admitRequestedCodexPath } from './codex-requested-binary'
import {
  _internals as derivationInternals,
  deriveCodexHookFlagEntry,
  readCodexHookFlagCheck,
  readCodexHookFlagUncarriable,
  readCodexTooOldForHookFlag,
  readCodexVersion
} from './codex-hook-session-trust'

/**
 * Keeps Orca's Codex hook flag table true to the setting and to the codex
 * binaries in use. One never-throwing function, called at app start, on the
 * setting changing, on each native pane spawn, on Orca-side launch prep and
 * resume, and when a launch leaves a request in the table. Each call reads the
 * setting then; a derivation runs only for a binary whose fingerprint changed
 * since its last answer, so a call that finds nothing new spawns nothing.
 */

// Why a short settle: a burst of launches shares one sync.
const TABLE_SETTLE_MS = 100
// Why a cap: one entry per Codex version ever seen would otherwise accumulate.
const MAX_TABLE_ENTRIES = 8
// Why retried soon: a timeout at a loaded boot must not cost status until a restart.
const TRANSIENT_FAILURE_RETRY_MS = 60_000
const MISSING = 'missing'

type Known = {
  fingerprint: string
  version: string | null
  failure: string | null
  /** Per set of requested versions without an entry; '' is a sync with none. */
  failures: Map<string, { retryAt: number }>
}

let config: { isEnabled: () => boolean; watch: WatchFolder } | null = null
// Why: the CLI's process has no store; its toggle passes the setting it just saved.
let intent = false
// Why keyed by path: a fingerprint change (update, reinstall) re-derives that binary only.
// Why replaced, not cleared, at the opt-out: a run from before it keeps writing the old map.
let known = new Map<string, Known>()
const pendingPaths = new Set<string>()
let running: Promise<void> | null = null
let rerun = false
let spawnSyncScheduled = false
let tableWatch: FolderWatch | null = null

/** App start, main process only: the settings reader, and the first sync once PATH is hydrated. */
export function startCodexHookFlagSync(options: {
  isEnabled: () => boolean
  /** Shell PATH hydration, which resolving the codex command needs. */
  pathReady?: Promise<unknown>
  watch?: WatchFolder
}): () => void {
  config = {
    isEnabled: options.isEnabled,
    watch: options.watch ?? ((path, onChange) => watchFs(path, onChange))
  }
  tableWatch = createFolderWatch(config.watch, () => void syncCodexHookFlags(), TABLE_SETTLE_MS)
  void syncCodexHookFlags({ after: options.pathReady })
  return () => {
    tableWatch?.close()
    tableWatch = null
    config = null
  }
}

/**
 * Makes the table exist exactly while Codex hooks are on and derives what is
 * missing. `enabled` is only the CLI's saved setting; the app reads its store.
 * `codexPath` names a binary an Orca-side launch is about to run. Never throws.
 */
export function syncCodexHookFlags(
  options: { enabled?: boolean; codexPath?: string; after?: Promise<unknown> } = {}
): Promise<void> {
  try {
    if (options.enabled !== undefined) {
      intent = options.enabled
    } else if (!config) {
      return Promise.resolve()
    }
    if (!isEnabledNow()) {
      tableWatch?.close()
      known = new Map()
      pendingPaths.clear()
      removeCodexHookFlagTable()
      return Promise.resolve()
    }
    createCodexHookFlagTable()
    // Why nothing is derived without it: a flag whose script is missing runs nothing, or fails every event on Windows.
    if (!ensureCodexHookScript() || !config) {
      // Why no derivation in the CLI's process: the app derives at its next start.
      return Promise.resolve()
    }
    // Why not fatal when it fails: every pane spawn syncs, and the next sync watches again.
    tableWatch?.follow([getCodexHookFlagTablePath()])
    if (options.codexPath) {
      pendingPaths.add(options.codexPath)
    }
    if (running) {
      rerun = true
      return running
    }
    const after = options.after ?? Promise.resolve()
    running = after.catch(() => {}).then(runUntilSettled)
    return running
  } catch (error) {
    console.warn('[codex-hook-session] Codex hook flag sync failed:', error)
    return Promise.resolve()
  }
}

/** A native pane spawned: syncs on the next tick, off the spawn's path, in the app's process only. */
export function scheduleCodexHookFlagSync(): void {
  // Why once: one spawn builds its env through several builders, each of which asks.
  if (config && !spawnSyncScheduled) {
    spawnSyncScheduled = true
    setImmediate(() => {
      spawnSyncScheduled = false
      void syncCodexHookFlags()
    })
  }
}

/** A sync, waited for at most `timeoutMs`: a resume launches without its flag rather than wait longer. */
export async function syncCodexHookFlagsWithin(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    syncCodexHookFlags(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}

/** What this process last learned about the codex it resolves; null before it has. */
export function getKnownCodexHookFlag(): { version: string | null; failure: string | null } | null {
  const answer = known.get(normalizeRuntimePathForComparison(resolveCodexCommand()))
  return answer ? { version: answer.version, failure: answer.failure } : null
}

/** The CLI's process: learns its codex's version once, so status names that version's entry. */
export async function learnCodexHookFlagVersion(): Promise<void> {
  if (config) {
    return
  }
  const codexPath = resolveCodexCommand()
  const version = await readCodexVersion(codexPath).catch(() => null)
  known.set(normalizeRuntimePathForComparison(codexPath), {
    fingerprint: await fingerprintCodex(codexPath),
    version,
    failure: version
      ? (readCodexTooOldForHookFlag(version) ?? (await readCodexHookFlagUncarriable()))
      : `${codexPath} did not report its version`,
    failures: new Map()
  })
}

function isEnabledNow(): boolean {
  return config ? config.isEnabled() : intent
}

function ensureCodexHookScript(): boolean {
  try {
    writeManagedScript(getManagedScriptPath(), getManagedScript())
  } catch (error) {
    console.warn('[codex-hook-session] could not write the Codex hook script:', error)
    return false
  }
  return true
}

async function runUntilSettled(): Promise<void> {
  for (;;) {
    let again = false
    try {
      rerun = false
      await syncOnce()
      again = rerun && isEnabledNow()
    } catch (error) {
      console.warn('[codex-hook-session] Codex hook flag sync failed:', error)
    }
    // Why decided and cleared in one step: a call in between would mark a finished run.
    if (!again) {
      running = null
      return
    }
  }
}

async function syncOnce(): Promise<void> {
  const mainPath = resolveCodexCommand()
  const targets = new Map<string, Set<string>>([[mainPath, new Set()]])
  const target = (path: string): Set<string> => {
    const requested = targets.get(path) ?? new Set<string>()
    targets.set(path, requested)
    return requested
  }
  for (const path of pendingPaths) {
    target(resolveCodexProbePath(path))
  }
  pendingPaths.clear()
  for (const request of takeCodexHookFlagRequests()) {
    // Why main's codex otherwise: main runs no path it did not find itself.
    target(admitRequestedCodexPath(request.codexPath, mainPath) ?? mainPath).add(
      request.codexVersion
    )
  }
  await Promise.all([...targets].map(([path, requested]) => syncBinary(path, requested)))
  const isCurrent = await readCodexHookFlagCheck()
  // Why only with a known definition: an unknown one proves no entry stale.
  if (isCurrent && isEnabledNow() && codexHookFlagTableExists()) {
    pruneCodexHookFlagEntries((entry) => isCurrent(entry.flag), MAX_TABLE_ENTRIES)
  }
}

async function syncBinary(codexPath: string, requested: ReadonlySet<string>): Promise<void> {
  const answers = known
  const key = normalizeRuntimePathForComparison(codexPath)
  const fingerprint = await fingerprintCodex(codexPath)
  const stored = answers.get(key)
  const previous = stored?.fingerprint === fingerprint ? stored : undefined
  // Why the requested versions count: a shim's bytes stay the same when the codex behind it updates.
  const wanted = [...requested].filter((version) => readCodexHookFlagEntry(version) === null)
  if (
    previous?.version &&
    wanted.length === 0 &&
    readCodexHookFlagEntry(previous.version) !== null
  ) {
    return
  }
  const failureKey = wanted.sort().join('\n')
  // Why skip a cached failure: the same bytes asked the same question; a new binary, a toggle or its retry time asks again.
  if ((previous?.failures.get(failureKey)?.retryAt ?? 0) > Date.now()) {
    return
  }
  const result =
    fingerprint === MISSING
      ? { codexVersion: null, entry: null, failure: `${codexPath} was not found`, transient: false }
      : await deriveCodexHookFlagEntry(
          codexPath,
          () => isEnabledNow() && codexHookFlagTableExists()
        )
  // Why: an opt-out meanwhile replaced the map, and its answer belongs to the old setting.
  if (answers !== known || !isEnabledNow()) {
    return
  }
  const failure =
    result.failure ??
    (wanted.length > 0 && result.codexVersion && !wanted.includes(result.codexVersion)
      ? `${codexPath} reports ${result.codexVersion}, not ${wanted.join(', ')}`
      : null)
  const failures = previous?.failures ?? new Map<string, { retryAt: number }>()
  if (failure) {
    failures.set(failureKey, {
      retryAt: result.transient ? Date.now() + TRANSIENT_FAILURE_RETRY_MS : Number.POSITIVE_INFINITY
    })
  } else {
    failures.delete(failureKey)
  }
  answers.set(key, { fingerprint, version: result.codexVersion, failure, failures })
}

// Why these fields: they change when an update or reinstall replaces the binary behind the path.
async function fingerprintCodex(codexPath: string): Promise<string> {
  try {
    const realPath = await realpath(codexPath)
    const info = await stat(realPath)
    return `${realPath}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return MISSING
  }
}

export const _internals = {
  resetForTesting(): void {
    tableWatch?.close()
    tableWatch = null
    config = null
    intent = false
    known = new Map()
    pendingPaths.clear()
    running = null
    rerun = false
    spawnSyncScheduled = false
    derivationInternals.resetForTesting()
  },
  forgetHookCommandForTesting(): void {
    derivationInternals.resetForTesting()
  }
}
