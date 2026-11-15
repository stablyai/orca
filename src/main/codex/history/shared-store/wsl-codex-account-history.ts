import { WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME } from '../../../../shared/remote-bundle-artifacts'
import { runWslGuestNodeHelper } from '../../../wsl/execution/wsl-guest-node-helper'
import { runWslProcess } from '../../../wsl/execution/wsl-runner'
import { assertWslUncPathRunning } from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { onRunningWslDistrosStopped } from '../../../wsl/discovery/wsl-running-distro-cache'
import { onWslDistroGateNote } from '../../../wsl/discovery/wsl-background-distro-gate'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { buildWslHealInvocation } from '../index/codex-session-index-heal'
import {
  healCodexIndexPendingRollouts,
  isCodexAccountHistoryWorkStopping
} from './codex-account-history-index'

export type WslCodexAccountHistoryTarget = {
  distro: string
  /** Linux paths inside the distro. */
  accountHome: string
  storeHome: string
  shared: boolean
}

type WslAccountHistoryDependencies = {
  runHelper: typeof runWslGuestNodeHelper
  /** Throws unless the distro runs; each step outlives the launch that started it (E9). */
  requireRunning: (distro: string) => Promise<void>
  subscribeStops: typeof onRunningWslDistrosStopped
}

const defaultDependencies: WslAccountHistoryDependencies = {
  runHelper: runWslGuestNodeHelper,
  requireRunning: (distro) => assertWslUncPathRunning('', distro),
  // Gate notes carry running-list stops and explicit ones (a relay or watcher exit) no list saw yet.
  subscribeStops: (listener) =>
    onWslDistroGateNote((note) => {
      if (note.kind === 'stopped') {
        listener([note.distro], [])
      }
    })
}

// The helper may move a whole history on first run; pending names are ~75 bytes each.
const HELPER_TIMEOUT_MS = 10 * 60_000
const HELPER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const CLEAR_TIMEOUT_MS = 30_000

type HelperOutput = { result: string; pendingDir: string; pending: string[] }

/** Links (or unlinks) the home inside its distro; the guest helper also owns its sqlite_home. */
async function linkInGuest(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<HelperOutput | null> {
  // Every wsl.exe step re-checks: the user may stop the distro mid-pass, and a step would boot it.
  await dependencies.requireRunning(target.distro)
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: [target.shared ? 'share' : 'unshare', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    maxOutputBytes: HELPER_MAX_OUTPUT_BYTES
  })
  return parseHelperOutput(stdout)
}

/** Marker lines precede the summary; a missing summary means the list may be clipped. */
function parseHelperOutput(stdout: string): HelperOutput | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let summary: unknown
  try {
    summary = JSON.parse(lines.at(-1) ?? '')
  } catch {
    return null
  }
  if (
    !summary ||
    typeof summary !== 'object' ||
    !('pendingDir' in summary) ||
    typeof summary.pendingDir !== 'string'
  ) {
    return null
  }
  // Login scripts may print before the helper; only rollout names are markers.
  return {
    result: 'result' in summary && typeof summary.result === 'string' ? summary.result : '',
    pendingDir: summary.pendingDir,
    pending: lines.slice(0, -1).filter((line) => line.startsWith('rollout-'))
  }
}

/** Codex's own `thread/read` inside the distro indexes moved rollouts against the guest store. */
async function healInGuest(
  target: WslCodexAccountHistoryTarget,
  output: HelperOutput,
  dependencies: WslAccountHistoryDependencies,
  isPaused: () => boolean
): Promise<void> {
  const distroKey = target.distro.toLowerCase()
  let distroStopped = false
  const unsubscribe = dependencies.subscribeStops((stopped) => {
    distroStopped ||= stopped.some((distro) => distro.toLowerCase() === distroKey)
  })
  const stillRunning = async (): Promise<void> => {
    await dependencies.requireRunning(target.distro).catch((error: unknown) => {
      distroStopped = true
      throw error
    })
  }
  try {
    await healCodexIndexPendingRollouts({
      storeHome: target.storeHome,
      rolloutNames: output.pending,
      clear: async (names) => {
        await stillRunning()
        await clearPendingMarkers(target.distro, output.pendingDir, names)
      },
      options: {
        // Windows can't take SQLite's locks over \\wsl.localhost; the guest's own codex indexes.
        buildInvocation: (_home, timeoutMs) =>
          buildWslHealInvocation(target.distro, target.storeHome, timeoutMs),
        runSession: async (invocation, body) => {
          await stillRunning()
          return runCodexAppServerSession(invocation, body)
        },
        shouldStop: () => distroStopped || isPaused()
      }
    })
  } finally {
    unsubscribe()
  }
}

async function clearPendingMarkers(
  distro: string,
  pendingDir: string,
  names: readonly string[]
): Promise<void> {
  if (names.length === 0) {
    return
  }
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: 'cd -- "$1" || exit 1\nshift\nrm -f -- "$@"',
    args: [pendingDir, ...names],
    timeoutMs: CLEAR_TIMEOUT_MS
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Could not clear WSL Codex index markers (code ${result.code})`)
  }
}

type QueuedPass = { shared: boolean; pass: Promise<void> }

/**
 * WSL account history passes, in request order per home (a request joins only the latest queued
 * one with the same mode); indexing runs detached, one at a time per distro.
 */
export class WslCodexAccountHistoryLaunches {
  private readonly latest = new Map<string, QueuedPass>()
  private readonly heals = new Map<string, Promise<void>>()
  // The newest guest marker list per distro, indexed once no pass runs there.
  private readonly owedHeals = new Map<
    string,
    { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  >()
  private readonly activePasses = new Map<string, number>()
  // A home settled in a mode this run skips later guest passes in it.
  private readonly settledThisRun = new Map<string, boolean>()

  constructor(private readonly dependencies: WslAccountHistoryDependencies = defaultDependencies) {}

  run(target: WslCodexAccountHistoryTarget): Promise<void> {
    if (isCodexAccountHistoryWorkStopping()) {
      return Promise.resolve()
    }
    const distroKey = target.distro.toLowerCase()
    const key = `${distroKey}\0${target.accountHome}`
    const previous = this.latest.get(key)
    if (previous?.shared === target.shared) {
      return previous.pass
    }
    const pass = (previous?.pass ?? Promise.resolve())
      .then(async () => {
        if (this.settledThisRun.get(key) === target.shared) {
          return
        }
        this.settledThisRun.delete(key)
        this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 0) + 1)
        try {
          const output = await linkInGuest(target, this.dependencies)
          if (output && output.result === (target.shared ? 'shared' : 'unshared')) {
            this.settledThisRun.set(key, target.shared)
          }
          if (output && output.pending.length > 0) {
            this.owedHeals.set(distroKey, { target, output })
          }
        } finally {
          this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 1) - 1)
          this.startOwedHeal(distroKey)
        }
      })
      .catch((error: unknown) => {
        console.warn('[codex-account-history] WSL account history pass failed:', error)
      })
    this.latest.set(key, { shared: target.shared, pass })
    void pass.finally(() => {
      if (this.latest.get(key)?.pass === pass) {
        this.latest.delete(key)
      }
    })
    return pass
  }

  // A pass may have recorded markers for files not moved yet, which a read would settle as missing.
  private startOwedHeal(distroKey: string): void {
    const isPaused = (): boolean => (this.activePasses.get(distroKey) ?? 0) > 0
    const owed = this.owedHeals.get(distroKey)
    if (!owed || isPaused() || this.heals.has(distroKey) || isCodexAccountHistoryWorkStopping()) {
      return
    }
    this.owedHeals.delete(distroKey)
    const heal = healInGuest(owed.target, owed.output, this.dependencies, isPaused)
      .catch((error: unknown) => {
        console.warn('[codex-account-history] Indexing WSL shared history failed:', error)
      })
      .finally(() => {
        this.heals.delete(distroKey)
        this.startOwedHeal(distroKey)
      })
    this.heals.set(distroKey, heal)
  }
}
