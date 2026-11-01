import type { DevLoadResult, LogsResult } from '../handlers/plugin-runtime'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import type {
  PluginDevWatchApproval,
  PluginDevWatchEvent,
  PluginDevWatchStatus
} from './plugin-dev-watch-events'
import { PluginLogFollower } from './plugin-log-follower'
import { devLoadWithApproval, type PluginDevWatchConfirm } from './plugin-dev-watch-approval'
import { PluginFrameLogDedupe, type PluginDevWatchLogLine } from './plugin-frame-log-dedupe'
import {
  createPluginDevWatchCheckQueue,
  type PluginDevWatchCheckResult
} from './plugin-dev-watch-check'
import {
  createPluginDevWatchShooter,
  PLUGIN_DEV_WATCH_SHOOTABLE,
  type PluginDevWatchShotHost
} from './plugin-dev-watch-shot'

/** What the loop asks of the Orca host; the handler binds it to RPC for one folder. */
export type PluginDevWatchHost = {
  refreshTypes(): Promise<string[]>
  /** `approvalFingerprint` overrides `--approve` once the person approved at the prompt. */
  devLoad(approvalFingerprint?: string): Promise<DevLoadResult>
  list(): Promise<PluginHostListEntry[]>
  logs(pluginKey: string, after: string | undefined): Promise<LogsResult>
  /** Re-checks the folder's approval; null when it needs none. */
  approvalNeeded(): Promise<PluginDevWatchApproval | null>
  devUnload(): Promise<void>
  /** `--check` only: validates the folder and renders its components panels once. */
  check?: () => Promise<PluginDevWatchCheckResult>
  /** `--shot` only: a PNG of one panel after each good reload, while it stays on screen. */
  shot?: PluginDevWatchShotHost
}

export type PluginDevWatchDeps = {
  host: PluginDevWatchHost
  emit(event: PluginDevWatchEvent): void
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>
  /** Subscribes to Ctrl-C (and the platform's other stop signals); returns the unsubscribe. */
  onInterrupt(listener: () => void): () => void
  exitNow(code: number): void
  isConnectionLost(error: unknown): boolean
  /** Only for a person at a terminal without `--json`: asks to approve a first load that needs it. */
  confirm?: PluginDevWatchConfirm
}

// Why these rates: logs feel live at 500 ms, and the plugin list (a projection of every plugin) is
// heavier, so it is read once a second.
export const PLUGIN_DEV_WATCH_POLL_MS = 500
const LIST_EVERY_POLLS = 2
const INTERRUPTED_EXIT_CODE = 130

type Snapshot = {
  status: PluginDevWatchStatus
  error?: string
  needsApproval: boolean
  devChangeCount?: number
}

function snapshotOf(entry: PluginHostListEntry | null | undefined): Snapshot {
  if (!entry) {
    return { status: 'missing', needsApproval: false }
  }
  return {
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    needsApproval: entry.status === 'pending' || entry.needsReconsent,
    ...(entry.devChangeCount === undefined ? {} : { devChangeCount: entry.devChangeCount })
  }
}

/** Our entry, or the one new invalid dev entry: a manifest that no longer parses loses its key. */
function findEntry(
  list: readonly PluginHostListEntry[],
  pluginKey: string,
  otherKeys: ReadonlySet<string>
): PluginHostListEntry | undefined {
  const own = list.find((entry) => entry.pluginKey === pluginKey)
  if (own) {
    return own
  }
  const strays = list.filter(
    (entry) => entry.isDev && entry.status === 'invalid' && !otherKeys.has(entry.pluginKey)
  )
  return strays.length === 1 ? strays[0] : undefined
}

/** A check that renders still fails while Orca itself does not run the plugin. */
function checkEvent(
  pluginKey: string,
  result: PluginDevWatchCheckResult,
  snapshot: Snapshot
): PluginDevWatchEvent {
  return {
    type: 'check',
    pluginKey,
    ...result,
    ok: result.ok && PLUGIN_DEV_WATCH_SHOOTABLE.has(snapshot.status),
    checkOk: result.ok,
    pluginStatus: snapshot.status,
    ...(snapshot.error ? { pluginError: snapshot.error } : {})
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `--shot`: picks the panel once; an unknown `--shot-panel` unloads what this run loaded and fails. */
async function startShooter(
  host: PluginDevWatchHost,
  loaded: DevLoadResult,
  emit: (event: PluginDevWatchEvent) => void
): Promise<(() => Promise<void>) | null> {
  if (!host.shot) {
    return null
  }
  let panelId: string | null
  try {
    panelId = host.shot.panelOf(loaded.plugin)
  } catch (error) {
    if (loaded.added) {
      await host.devUnload().catch(() => undefined)
    }
    throw error
  }
  if (panelId === null) {
    emit({ type: 'warning', message: `${loaded.pluginKey} has no panel for --shot to capture` })
    return null
  }
  return createPluginDevWatchShooter(host.shot, loaded.pluginKey, panelId, emit)
}

/** Loads the folder, then streams its logs and reload status until interrupted. Returns the exit
 *  code. A failed first load throws (approval_required exits 3 like `orca plugin dev load`) unless
 *  the person approves it at the `confirm` prompt. */
export async function runPluginDevWatch(deps: PluginDevWatchDeps): Promise<number> {
  const { host, emit } = deps
  const typeFiles = await host.refreshTypes()
  const loaded = await devLoadWithApproval((fingerprint) => host.devLoad(fingerprint), deps.confirm)
  const { pluginKey } = loaded
  let snapshot = snapshotOf(loaded.plugin)
  emit({
    type: 'loaded',
    pluginKey,
    path: loaded.path,
    added: loaded.added,
    status: snapshot.status,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    typeFiles
  })

  const stop = new AbortController()
  let interrupts = 0
  const unsubscribe = deps.onInterrupt(() => {
    interrupts += 1
    if (interrupts > 1) {
      deps.exitNow(INTERRUPTED_EXIT_CODE)
      return
    }
    stop.abort()
  })
  const runCheck = host.check
  const shoot = await startShooter(host, loaded, emit)
  // Check, then shot: one at a time, and saves during a run coalesce into one more.
  const afterLoad =
    runCheck || shoot
      ? createPluginDevWatchCheckQueue(async () => {
          if (runCheck) {
            try {
              emit(checkEvent(pluginKey, await runCheck(), snapshot))
            } catch (error) {
              emit({ type: 'warning', message: `check could not run: ${errorMessage(error)}` })
            }
          }
          if (shoot && PLUGIN_DEV_WATCH_SHOOTABLE.has(snapshot.status)) {
            await shoot()
          }
        })
      : null
  afterLoad?.request()
  const follower = new PluginLogFollower()
  const dedupe = new PluginFrameLogDedupe()
  const emitLogs = (lines: readonly PluginDevWatchLogLine[]): void => {
    for (const line of lines) {
      emit({ type: 'log', pluginKey, ...line })
    }
  }
  let otherKeys: ReadonlySet<string> | null = null
  let lastWarning: string | null = null

  const pollLogs = async (): Promise<void> => {
    emitLogs(dedupe.take(follower.take(await host.logs(pluginKey, follower.cursor))))
  }

  const pollStatus = async (): Promise<void> => {
    const list = await host.list()
    otherKeys ??= new Set(list.map((entry) => entry.pluginKey).filter((key) => key !== pluginKey))
    const next = snapshotOf(findEntry(list, pluginKey, otherKeys))
    const changes =
      next.devChangeCount !== undefined && snapshot.devChangeCount !== undefined
        ? next.devChangeCount - snapshot.devChangeCount
        : 0
    const error = next.error ? { error: next.error } : {}
    if (changes > 0) {
      emitLogs(dedupe.flush())
      emit({ type: 'reloaded', pluginKey, changes, status: next.status, ...error })
    } else if (next.status !== snapshot.status || next.error !== snapshot.error) {
      emit({
        type: 'status',
        pluginKey,
        status: next.status,
        previousStatus: snapshot.status,
        ...error
      })
    }
    const newlyNeedsApproval = next.needsApproval && !snapshot.needsApproval
    snapshot = next
    if (changes > 0) {
      afterLoad?.request()
    }
    if (newlyNeedsApproval) {
      const approval = await host.approvalNeeded()
      if (approval) {
        emit({ type: 'approval', pluginKey, ...approval })
      }
    }
  }

  try {
    let polls = -1
    while (!stop.signal.aborted) {
      try {
        if (polls === -1) {
          // Baseline: only lines written from now on are streamed.
          follower.take(await host.logs(pluginKey, undefined))
        } else {
          // Status first, so a reload's `reloaded` line precedes the lines its new code logs.
          if (polls % LIST_EVERY_POLLS === 0) {
            await pollStatus()
          }
          await pollLogs()
        }
        lastWarning = null
      } catch (error) {
        if (deps.isConnectionLost(error)) {
          emit({ type: 'disconnected', message: errorMessage(error) })
          return 1
        }
        // Why once: a host-side failure repeats every poll until something changes.
        const message = errorMessage(error)
        if (message !== lastWarning) {
          emit({ type: 'warning', message })
          lastWarning = message
        }
      }
      polls += 1
      await deps.wait(PLUGIN_DEV_WATCH_POLL_MS, stop.signal)
    }
    // A check or shot that is still running reports before the unload line.
    await afterLoad?.idle()
    emitLogs(dedupe.flush())
    if (!loaded.added) {
      emit({ type: 'unloaded', pluginKey, path: loaded.path, removed: false })
      return 0
    }
    try {
      await host.devUnload()
    } catch (error) {
      emit({
        type: deps.isConnectionLost(error) ? 'disconnected' : 'warning',
        message: `could not unload ${loaded.path}: ${errorMessage(error)}`
      })
      return 1
    }
    emit({ type: 'unloaded', pluginKey, path: loaded.path, removed: true })
    return 0
  } finally {
    unsubscribe()
  }
}
