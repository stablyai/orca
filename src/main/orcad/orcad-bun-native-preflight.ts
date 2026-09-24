import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPtySpawnHealthProbe } from '../daemon/pty-subprocess/spawn-preflight'
import { WatcherProcessSupervisor } from '../ipc/parcel-watcher-process-supervisor'
import { resolveWatcherProcessEntryPath } from '../ipc/parcel-watcher-entry-path'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import {
  isWindowsProcessTableAvailable,
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessIdentityTableFresh
} from '../windows/windows-process-table'

/** The candidate process owns disposable PTY and watcher probes before it touches user state. */
export async function preflightOrcadBunNativeRuntime(): Promise<void> {
  if (process.platform === 'win32') {
    await preflightWindowsProcessIdentity()
  }
  await runPtySpawnHealthProbe()
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
      const error = new Error('Bun file watcher readiness timed out')
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

async function preflightWindowsProcessIdentity(): Promise<void> {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    throw new Error('The bundled Windows process table must support process creation times')
  }
  const rows = await readWindowsProcessIdentityTableFresh()
  const self = rows.find((row) => row.pid === process.pid)
  const created = self?.creationTimeMs
  if (created === undefined || !Number.isFinite(created) || created <= 0 || created > Date.now()) {
    throw new Error('The bundled Windows process table could not identify this process')
  }
}
