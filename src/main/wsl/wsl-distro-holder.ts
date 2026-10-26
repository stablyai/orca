import type { EventEmitter } from 'node:events'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { spawnProcess } from '@orca/process-host'
import { queryWindowsProcess } from '../daemon/daemon-process-inspection'
import type { WindowsProcessEvidence } from '../daemon/daemon-incarnation-evidence-types'
import { listConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslDistroHolderArgs, isWslDistroHolderCommandLine } from './wsl-distro-holder-command'
import {
  listWslDistroHolderRecordDistros,
  readWslDistroHolderRecord,
  removeWslDistroHolderRecord,
  wslDistroHolderKey,
  writeWslDistroHolderRecord,
  type WslDistroHolderRecord
} from './wsl-distro-holder-record'
import { resolveWslExecutablePath } from './wsl-executable-path'

/** Holder liveness, in the execution-host vocabulary: lookup failure is never `exited`. */
export type WslDistroHolderState = 'live' | 'exited' | 'unverifiable'

export type WslDistroHolderEnsureResult =
  | { outcome: 'adopted'; record: WslDistroHolderRecord }
  | { outcome: 'spawned'; record: WslDistroHolderRecord }
  /** The recorded holder could not be checked; kept rather than doubled (it may be live). */
  | { outcome: 'unverifiable'; record: WslDistroHolderRecord }

/** Minimal child lifecycle: spawn/error/exit, PID and unref. */
export type WslDistroHolderChild = EventEmitter & { readonly pid?: number; unref(): void }

export type WslDistroHolderAdoption = { distro: string; state: WslDistroHolderState }

export type WslDistroHolderDependencies = {
  userDataPath: string
  /** Test seam; production spawns `wsl.exe` detached through process-host. */
  spawnHolder?: (distro: string) => WslDistroHolderChild
  queryProcess?: (pid: number) => Promise<WindowsProcessEvidence>
  killProcess?: (pid: number) => void
  /** Must never boot a distro: `wsl --list --running` only. */
  listRunningDistros?: () => Promise<string[]>
  /** Wall clock, only for the record's `startedAtMs` stamp. */
  now?: () => number
  /** Deadlines and the unverifiable bound; monotonic so a clock jump moves neither. */
  monotonicNow?: () => number
  /** A holder this process spawned exited (code 1 when its distro stopped); liveness re-checks. */
  onHolderExit?: (
    distro: string,
    exit: { code: number | null; signal: NodeJS.Signals | null }
  ) => void
  sleep?: (ms: number) => Promise<void>
  /** How long a spawned holder has to bring its distro up (a cold boot can take ~15 s). */
  bootTimeoutMs?: number
}

export type WslDistroHolder = {
  /** User-initiated only: the one path allowed to boot a stopped distro. */
  ensureHeld(distro: string): Promise<WslDistroHolderEnsureResult>
  /** Startup: keep holders a previous Orca left running, drop records that are provably stale. */
  adoptHolders(): Promise<WslDistroHolderAdoption[]>
  /** Explicit stop only; the distro then idles out on WSL's own schedule. */
  release(distro: string): Promise<WslDistroHolderState>
  holderState(distro: string): Promise<WslDistroHolderState>
}

const DEFAULT_BOOT_TIMEOUT_MS = 60_000
const BOOT_POLL_INTERVAL_MS = 250
const RELEASE_EXIT_TIMEOUT_MS = 5_000
/** Replace unverifiable holders only after this monotonic grace while confirmed running. A duplicate costs a sleep and may keep the distro alive after release; log the old PID. */
export const WSL_HOLDER_UNVERIFIABLE_REPLACE_AFTER_MS = 5 * 60_000

function spawnDetachedHolder(distro: string): WslDistroHolderChild {
  // Detached holders outlive Orca's libuv kill-on-close job; explicit taskkill /T still reaches descendants.
  return spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslDistroHolderArgs(distro),
    // A host-wide holder must never pin a worktree as its Windows cwd.
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    detached: true,
    stdio: 'ignore'
  })
}

/** Pid + creation time + command line must all agree; any one contradicting means pid reuse. */
export function classifyWslDistroHolderProcess(
  record: WslDistroHolderRecord,
  evidence: WindowsProcessEvidence
): WslDistroHolderState {
  if (evidence.status === 'unavailable') {
    return 'unverifiable'
  }
  if (evidence.status === 'missing') {
    return 'exited'
  }
  const timeKnown = record.creationTimeMs !== null && evidence.startedAtMs !== null
  if (timeKnown && record.creationTimeMs !== evidence.startedAtMs) {
    return 'exited'
  }
  if (!evidence.commandLine) {
    return 'unverifiable'
  }
  if (!isWslDistroHolderCommandLine(evidence.commandLine, record.distro)) {
    return 'exited'
  }
  // A record written without a creation time never had one to compare; the command line decides.
  return timeKnown || record.creationTimeMs === null ? 'live' : 'unverifiable'
}

export function createWslDistroHolder(dependencies: WslDistroHolderDependencies): WslDistroHolder {
  const { userDataPath } = dependencies
  const spawnHolder = dependencies.spawnHolder ?? spawnDetachedHolder
  const queryProcess = dependencies.queryProcess ?? ((pid: number) => queryWindowsProcess(pid))
  const killProcess = dependencies.killProcess ?? ((pid: number) => process.kill(pid))
  const listRunningDistros = dependencies.listRunningDistros ?? listConfirmedRunningWslDistros
  const now = dependencies.now ?? Date.now
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  const unverifiableSince = new Map<string, number>()
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const bootTimeoutMs = dependencies.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS

  const tails = new Map<string, Promise<void>>()
  const inFlightEnsures = new Map<string, Promise<WslDistroHolderEnsureResult>>()

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
        await stopRecordedHolder(record)
        throw error
      }
      const { onHolderExit } = dependencies
      if (onHolderExit) {
        child.once('exit', (code, signal) => onHolderExit(distro, { code, signal }))
      }
      return record
    } finally {
      child.off('exit', onExit)
    }
  }

  async function stopRecordedHolder(record: WslDistroHolderRecord): Promise<WslDistroHolderState> {
    let state = classifyWslDistroHolderProcess(record, await queryProcess(record.pid))
    if (state === 'live') {
      try {
        // WSL 2.7.10 relaunches a same-argv child; killing the recorded parent ends both.
        killProcess(record.pid)
      } catch {
        // Raced its own exit, or denied; the re-check below decides.
      }
      const deadline = monotonicNow() + RELEASE_EXIT_TIMEOUT_MS
      for (;;) {
        state = classifyWslDistroHolderProcess(record, await queryProcess(record.pid))
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
    return state
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

  return {
    ensureHeld(distro) {
      const key = wslDistroHolderKey(distro)
      if (!key) {
        return Promise.reject(new Error('A WSL distro name is required'))
      }
      const existing = inFlightEnsures.get(key)
      if (existing) {
        return existing
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
          return { outcome: 'spawned', record: await spawnAndRecord(distro) }
        }
        if (state === 'unverifiable') {
          throw new Error(`The WSL holder record for ${distro} could not be read`)
        }
        return { outcome: 'spawned', record: await spawnAndRecord(distro) }
      }).finally(() => {
        if (inFlightEnsures.get(key) === pending) {
          inFlightEnsures.delete(key)
        }
      })
      inFlightEnsures.set(key, pending)
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

    release(distro) {
      return serialize(distro, async () => {
        const read = await readWslDistroHolderRecord(userDataPath, distro)
        if (read.status === 'unreadable') {
          return 'unverifiable'
        }
        if (read.status !== 'present') {
          await removeWslDistroHolderRecord(userDataPath, distro)
          return 'exited'
        }
        return stopRecordedHolder(read.record)
      })
    },

    holderState(distro) {
      return serialize(distro, async () => (await recordedHolderState(distro)).state)
    }
  }
}
