import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PtySpawnHealthTimeoutError,
  PTY_SPAWN_HEALTH_TIMEOUT_MS,
  runPtySpawnHealthProbe
} from '../daemon/pty-subprocess/spawn-preflight'
import { WatcherProcessSupervisor } from '../ipc/parcel-watcher-process-supervisor'
import { resolveWatcherProcessEntryPath } from '../ipc/parcel-watcher-entry-path'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import {
  isWindowsProcessTableAvailable,
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime,
  readWindowsProcessIdentityTableFresh
} from '../windows/windows-process-table'
import { WindowsProcessTableTimeoutError } from '../windows/windows-process-table-timeout-error'

// A cold first conpty spawn on a slow (arm64, AV-scanned) Windows host can outlast the steady-state budget.
const WINDOWS_FIRST_PTY_PROBE_TIMEOUT_MS = 15_000

/** The candidate process owns disposable PTY and watcher probes before it touches user state. */
export async function preflightOrcadNativeRuntime(
  options: { nativeFeatures?: boolean } = {}
): Promise<void> {
  if (process.platform === 'win32') {
    await preflightWindowsProcessIdentity()
  }
  // Runtime health checks can degrade independently; artifact qualification remains strict.
  if (options.nativeFeatures === false) {
    return
  }
  await probePtySpawn()
  const directory = await mkdtemp(join(tmpdir(), 'orca-native-ready-'))
  const supervisor = new WatcherProcessSupervisor({
    entryPath: resolveWatcherProcessEntryPath(resolveOrcadInstallRoot(), false),
    useInProcessVitestFallback: false
  })
  const cancellation = new AbortController()
  let subscription: { unsubscribe(): Promise<void> } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let resolveDelivery: () => void = () => {}
    let rejectDelivery: (error: unknown) => void = () => {}
    const delivered = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve
      rejectDelivery = reject
    })
    // A native callback can fail while subscribe is pending.
    void delivered.catch(() => {})
    timer = setTimeout(() => {
      const error = new Error('Bundled file watcher readiness timed out')
      cancellation.abort(error)
      rejectDelivery(error)
    }, 5_000)
    subscription = await supervisor.subscribe(
      directory,
      (error, events) => {
        if (error) {
          rejectDelivery(error)
        } else if (events.some((event) => event.path === join(directory, 'ready'))) {
          resolveDelivery()
        }
      },
      process.platform === 'win32' ? { backend: 'windows' } : {},
      { signal: cancellation.signal, subscribeTimeoutMs: 5_000, onTerminalError: rejectDelivery }
    )
    await writeFile(join(directory, 'ready'), '')
    await delivered
  } finally {
    clearTimeout(timer)
    try {
      await subscription?.unsubscribe()
    } finally {
      supervisor.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** Retries once only after a timeout; a spawn error or non-zero exit fails immediately. */
async function probePtySpawn(): Promise<void> {
  const firstTimeoutMs =
    process.platform === 'win32' ? WINDOWS_FIRST_PTY_PROBE_TIMEOUT_MS : PTY_SPAWN_HEALTH_TIMEOUT_MS
  try {
    await runPtySpawnHealthProbe(firstTimeoutMs)
  } catch (error) {
    if (!(error instanceof PtySpawnHealthTimeoutError)) {
      throw error
    }
    await runPtySpawnHealthProbe(PTY_SPAWN_HEALTH_TIMEOUT_MS)
  }
}

async function preflightWindowsProcessIdentity(): Promise<void> {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    throw new Error('The bundled Windows process table must support process creation times')
  }
  let created: number | null | undefined
  try {
    const rows = await readWindowsProcessIdentityTableFresh()
    created = rows.find((row) => row.pid === process.pid)?.creationTimeMs
  } catch (error) {
    // Only slowness falls back: an unreadable table (EDR hook, restricted token) must still
    // fail qualification, or every later liveness verdict on this host reads unverifiable.
    if (!(error instanceof WindowsProcessTableTimeoutError)) {
      throw error
    }
    // The addon's one-PID query proves this runtime can identify a process without a snapshot.
    created = readWindowsProcessCreationTime(process.pid)
    if (created === null) {
      throw error
    }
  }
  if (
    created === undefined ||
    created === null ||
    !Number.isFinite(created) ||
    created <= 0 ||
    created > Date.now()
  ) {
    throw new Error('The bundled Windows process table could not identify this process')
  }
}
