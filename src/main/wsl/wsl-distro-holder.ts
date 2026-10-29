import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { spawnDetachedWithoutInheritance } from '@orca/process-host/isolated-detached-spawn'
import { queryWindowsProcess } from '../daemon/daemon-process-inspection'
import {
  listConfirmedRunningWslDistros,
  noteWslDistroMayHaveStopped
} from '../wsl-background-distro-gate'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslDistroHolderArgs } from './wsl-distro-holder-command'
import {
  listWslDistroHolderRecordDistros,
  readWslDistroHolderRecord,
  removeWslDistroHolderRecord,
  wslDistroHolderKey,
  writeWslDistroHolderRecord,
  type WslDistroHolderRecord
} from './wsl-distro-holder-record'
import { resolveWslExecutablePath } from './wsl-executable-path'

export type {
  WslDistroHolder,
  WslDistroHolderAdoption,
  WslDistroHolderChild,
  WslDistroHolderDependencies,
  WslDistroHolderEnsureResult,
  WslDistroHolderState
} from './wsl-distro-holder-types'
import type {
  WslDistroHolder,
  WslDistroHolderChild,
  WslDistroHolderDependencies,
  WslDistroHolderEnsureResult,
  WslDistroHolderReleaseOptions,
  WslDistroHolderState
} from './wsl-distro-holder-types'

const DEFAULT_BOOT_TIMEOUT_MS = 60_000
const BOOT_POLL_INTERVAL_MS = 250
const RELEASE_EXIT_TIMEOUT_MS = 5_000
/** Replace unverifiable holders only after this monotonic grace while confirmed running. A duplicate costs a sleep and may keep the distro alive after release; log the old PID. */
export const WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS = 5 * 60_000

function spawnDetachedHolder(distro: string): WslDistroHolderChild {
  // Detached holders outlive Orca's libuv kill-on-close job; explicit taskkill /T still reaches descendants.
  // Inheriting none of Orca's handles keeps a launcher's pipe or a DevTools socket from outliving Orca.
  return spawnDetachedWithoutInheritance({
    program: resolveWslExecutablePath(),
    args: buildWslDistroHolderArgs(distro),
    // A host-wide holder must never pin a worktree as its Windows cwd.
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' }
  })
}

export { classifyWslDistroHolderProcess } from './wsl-distro-holder-process-classification'
import { classifyWslDistroHolderProcess } from './wsl-distro-holder-process-classification'

export function createWslDistroHolder(dependencies: WslDistroHolderDependencies): WslDistroHolder {
  const { userDataPath } = dependencies
  const spawnHolder = dependencies.spawnHolder ?? spawnDetachedHolder
  const queryProcess = dependencies.queryProcess ?? ((pid: number) => queryWindowsProcess(pid))
  const killProcess = dependencies.killProcess ?? ((pid: number) => process.kill(pid))
  const listRunningDistros = dependencies.listRunningDistros ?? listConfirmedRunningWslDistros
  const noteMayHaveStopped = dependencies.noteMayHaveStopped ?? noteWslDistroMayHaveStopped
  const now = dependencies.now ?? Date.now
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  const unverifiableSince = new Map<string, number>()
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const bootTimeoutMs = dependencies.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS

  const tails = new Map<string, Promise<void>>()
  const inFlightEnsures = new Map<
    string,
    { promise: Promise<WslDistroHolderEnsureResult>; gated: boolean }
  >()

  // Serialize ensure/release/adoption per distro; other distros remain independent.
  function serialize<T>(distro: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(tails, wslDistroHolderKey(distro), task)
  }

  async function recordedHolderState(
    distro: string
  ): Promise<{ state: WslDistroHolderState; record: WslDistroHolderRecord | null }> {
    const read = await readWslDistroHolderRecord(userDataPath, distro)
    if (read.status === 'absent') {
      return { state: 'exited', record: null }
    }
    if (read.status === 'unreadable') {
      return { state: 'unverifiable', record: null }
    }
    if (read.status === 'corrupt') {
      // Nothing in it can identify a process, so it holds nothing.
      await removeWslDistroHolderRecord(userDataPath, distro)
      return { state: 'exited', record: null }
    }
    const state = classifyWslDistroHolderProcess(read.record, await queryProcess(read.record.pid))
    const key = wslDistroHolderKey(distro)
    if (state === 'unverifiable') {
      if (!unverifiableSince.has(key)) {
        unverifiableSince.set(key, monotonicNow())
      }
    } else {
      unverifiableSince.delete(key)
    }
    if (state === 'exited') {
      await removeWslDistroHolderRecord(userDataPath, distro)
    }
    return { state, record: read.record }
  }

  type HolderExit = { code: number | null; signal: NodeJS.Signals | null }

  async function waitForDistroRunning(
    distro: string,
    observedExit: () => HolderExit | null
  ): Promise<void> {
    const deadline = monotonicNow() + bootTimeoutMs
    const key = wslDistroHolderKey(distro)
    for (;;) {
      const exit = observedExit()
      if (exit) {
        throw new Error(
          `WSL holder for ${distro} exited before the distro started (code ${exit.code}, signal ${exit.signal})`
        )
      }
      const running = await listRunningDistros()
      if (running.some((candidate) => wslDistroHolderKey(candidate) === key)) {
        return
      }
      if (monotonicNow() >= deadline) {
        throw new Error(`WSL distro ${distro} did not start within ${bootTimeoutMs} ms`)
      }
      await sleep(BOOT_POLL_INTERVAL_MS)
    }
  }

  async function spawnAndRecord(distro: string): Promise<WslDistroHolderRecord> {
    const child = spawnHolder(distro)
    // Observe exit before async lookup/recording; invalid distro names can fail immediately.
    const observed: { exit: HolderExit | null } = { exit: null }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      observed.exit = { code, signal }
    }
    child.once('exit', onExit)
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      // Unref so the surviving holder cannot keep Orca alive.
      child.unref()
      const pid = child.pid
      if (pid === undefined) {
        throw new Error(`WSL holder for ${distro} started without a pid`)
      }
      const evidence = await queryProcess(pid)
      const record: WslDistroHolderRecord = {
        version: 1,
        distro,
        pid,
        creationTimeMs: evidence.status === 'present' ? evidence.startedAtMs : null,
        startedAtMs: now()
      }
      await writeWslDistroHolderRecord(userDataPath, record)
      try {
        await waitForDistroRunning(distro, () => observed.exit)
      } catch (error) {
        // This process spawned it moments ago, so its pid is ours even without a start time.
        await stopRecordedHolder(record, { spawnedHere: true })
        throw error
      }
      const { onHolderExit } = dependencies
      child.once('exit', (code, signal) => {
        // Unfiltered and bridge-independent: no cooldown or open socket can hide this stop.
        if (code === 1) {
          noteMayHaveStopped(distro)
        }
        onHolderExit?.(distro, { code, signal })
      })
      return record
    } finally {
      child.off('exit', onExit)
    }
  }

  async function stopRecordedHolder(
    record: WslDistroHolderRecord,
    { spawnedHere = false, forUninstall = false } = {}
  ): Promise<WslDistroHolderState> {
    const classify = async (): Promise<WslDistroHolderState> =>
      classifyWslDistroHolderProcess(record, await queryProcess(record.pid), {
        commandLineSuffices: forUninstall
      })
    let state = await classify()
    if (state === 'unverifiable' && forUninstall) {
      await sleep(BOOT_POLL_INTERVAL_MS)
      state = await classify()
    }
    // A command line alone can't tell our holder from a reused pid running the same argv.
    const provenOurs = spawnedHere || record.creationTimeMs !== null || forUninstall
    const stateBeforeKill = state
    if (state === 'live' && provenOurs) {
      try {
        // WSL 2.7.10 relaunches a same-argv child; killing the recorded parent ends both.
        killProcess(record.pid)
      } catch {
        // Raced its own exit, or denied; the re-check below decides.
      }
      const deadline = monotonicNow() + RELEASE_EXIT_TIMEOUT_MS
      for (;;) {
        state = await classify()
        // Mid-exit rows may retain PID but lose command line; only exited proves termination.
        if (state === 'exited' || monotonicNow() >= deadline) {
          break
        }
        await sleep(BOOT_POLL_INTERVAL_MS)
      }
    }
    if (state === 'exited') {
      await removeWslDistroHolderRecord(userDataPath, record.distro)
    }
    if (forUninstall) {
      console.warn(
        `[wsl] uninstall: ${record.distro} holder pid ${record.pid} was ${stateBeforeKill}, now ${state}`
      )
    }
    return state === 'live' && !provenOurs ? 'unverifiable' : state
  }

  async function unverifiableTooLongWhileRunning(distro: string): Promise<boolean> {
    const key = wslDistroHolderKey(distro)
    const since = unverifiableSince.get(key)
    if (since === undefined || monotonicNow() - since < WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS) {
      return false
    }
    // Unreadable running lists must retain the recorded holder rather than spawn a duplicate.
    const running = await listRunningDistros()
    return running.some((candidate) => wslDistroHolderKey(candidate) === key)
  }

  const holder: WslDistroHolder = {
    ensureHeld(distro, options = {}) {
      const key = wslDistroHolderKey(distro)
      if (!key) {
        return Promise.reject(new Error('A WSL distro name is required'))
      }
      const { requireRunning } = options
      const existing = inFlightEnsures.get(key)
      if (existing) {
        // A user ensure must not inherit a background one's refusal of a stopped distro.
        return existing.gated && !requireRunning
          ? existing.promise.catch(() => holder.ensureHeld(distro))
          : existing.promise
      }
      const spawnIfAllowed = async (): Promise<WslDistroHolderRecord> => {
        if (requireRunning && !(await requireRunning())) {
          throw new WslDistroNotRunningError(distro)
        }
        return spawnAndRecord(distro)
      }
      const pending = serialize(distro, async (): Promise<WslDistroHolderEnsureResult> => {
        const { state, record } = await recordedHolderState(distro)
        if (record && state === 'live') {
          return { outcome: 'adopted', record }
        }
        if (record && state === 'unverifiable') {
          if (!(await unverifiableTooLongWhileRunning(distro))) {
            return { outcome: 'unverifiable', record }
          }
          console.warn(
            `[wsl] holder pid ${record.pid} for ${distro} stayed unverifiable; spawning another`
          )
          unverifiableSince.delete(key)
          return { outcome: 'spawned', record: await spawnIfAllowed() }
        }
        if (state === 'unverifiable') {
          throw new Error(`The WSL holder record for ${distro} could not be read`)
        }
        return { outcome: 'spawned', record: await spawnIfAllowed() }
      }).finally(() => {
        if (inFlightEnsures.get(key)?.promise === pending) {
          inFlightEnsures.delete(key)
        }
      })
      inFlightEnsures.set(key, { promise: pending, gated: Boolean(requireRunning) })
      return pending
    },

    async adoptHolders() {
      const distros = await listWslDistroHolderRecordDistros(userDataPath)
      return Promise.all(
        distros.map((distro) =>
          serialize(distro, async () => {
            const { state, record } = await recordedHolderState(distro)
            // The file name is the lowercase key; the record keeps the distro's own casing.
            return { distro: record?.distro ?? distro, state }
          })
        )
      )
    },

    release: (distro) => releaseRecorded(distro),

    async releaseAll(options) {
      const distros = await listWslDistroHolderRecordDistros(userDataPath)
      return Promise.all(
        distros.map(async (distro) => ({ distro, state: await releaseRecorded(distro, options) }))
      )
    },

    holderState(distro) {
      return serialize(distro, async () => (await recordedHolderState(distro)).state)
    }
  }
  return holder

  function releaseRecorded(
    distro: string,
    options: WslDistroHolderReleaseOptions = {}
  ): Promise<WslDistroHolderState> {
    return serialize(distro, async () => {
      const read = await readWslDistroHolderRecord(userDataPath, distro)
      if (read.status === 'unreadable') {
        return 'unverifiable'
      }
      if (read.status !== 'present') {
        await removeWslDistroHolderRecord(userDataPath, distro)
        return 'exited'
      }
      return stopRecordedHolder(read.record, options)
    })
  }
}
