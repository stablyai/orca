import { WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME } from '../../../../shared/remote-runtime/orcad-distribution/remote-bundle-artifacts'
import { runWslGuestNodeHelper } from '../../../wsl/execution/wsl-guest-node-helper'
import { runWslProcess } from '../../../wsl/execution/wsl-runner'
import { assertWslUncPathRunning } from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { onRunningWslDistrosStopped } from '../../../wsl/discovery/wsl-running-distro-cache'
import { onWslDistroGateNote } from '../../../wsl/discovery/wsl-background-distro-gate'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { buildWslHealInvocation } from '../index/codex-session-index-heal'
import { CodexHistoryPassRequests } from './codex-history-pass-queue'
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
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: [target.shared ? 'share' : 'unshare', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    maxOutputBytes: HELPER_MAX_OUTPUT_BYTES,
    requireRunning: () => dependencies.requireRunning(target.distro)
  })
  return parseHelperOutput(stdout)
}

/** Compares the home's left-behind rollouts with the guest store within the helper's budget. */
async function checkInGuest(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<void> {
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: ['check', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    requireRunning: () => dependencies.requireRunning(target.distro)
  })
  if (!parseHelperOutput(stdout)) {
    throw new Error('The WSL Codex history check printed no summary')
  }
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
  passes: { isPaused: () => boolean; startedSince: () => boolean }
): Promise<boolean> {
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
    return await healCodexIndexPendingRollouts({
      storeHome: target.storeHome,
      rolloutNames: output.pending,
      clear: async (names) => {
        await stillRunning()
        await clearPendingMarkers(target.distro, output.pendingDir, names)
      },
      passStartedSince: passes.startedSince,
      options: {
        // Windows can't take SQLite's locks over \\wsl.localhost; the guest's own codex indexes.
        buildInvocation: (_home, timeoutMs) =>
          buildWslHealInvocation(target.distro, target.storeHome, timeoutMs),
        runSession: async (invocation, body) => {
          await stillRunning()
          return runCodexAppServerSession(invocation, body)
        },
        shouldStop: () => distroStopped || passes.isPaused()
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

/**
 * WSL account history passes, one at a time per distro (homes merging into its store at once would
 * race on its folders), a launch's own ahead of background ones; indexing runs detached, one at a
 * time per distro.
 */
export class WslCodexAccountHistoryLaunches {
  private readonly requests = new CodexHistoryPassRequests()
  private readonly heals = new Map<string, Promise<void>>()
  // The newest guest marker list per distro, indexed once no pass runs there.
  private readonly owedHeals = new Map<
    string,
    { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  >()
  // A heal that failed waits for the next launch in that distro, not an immediate retry.
  private readonly failedHeals = new Map<
    string,
    { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  >()
  private readonly activePasses = new Map<string, number>()
  private readonly startedPasses = new Map<string, number>()
  // A home settled in a mode this run skips later guest passes in it.
  private readonly settledThisRun = new Map<string, boolean>()
  // Shared homes whose left-behind rollouts await a content check, one guest check per distro.
  private readonly owedChecks = new Map<string, WslCodexAccountHistoryTarget>()
  private readonly checks = new Set<string>()

  constructor(private readonly dependencies: WslAccountHistoryDependencies = defaultDependencies) {}

  run(
    target: WslCodexAccountHistoryTarget,
    { forLaunch = false }: { forLaunch?: boolean } = {}
  ): Promise<void> {
    if (isCodexAccountHistoryWorkStopping()) {
      return Promise.resolve()
    }
    const distroKey = target.distro.toLowerCase()
    const key = `${distroKey}\0${target.accountHome}`
    // A launch's own pass goes ahead of the distro's background ones, never behind a queued one.
    return this.requests.request(
      { queue: distroKey, home: key, shared: target.shared, forLaunch },
      async () => {
        try {
          await this.runPass(target, distroKey, key)
        } catch (error: unknown) {
          console.warn('[codex-account-history] WSL account history pass failed:', error)
        }
      }
    )
  }

  private async runPass(
    target: WslCodexAccountHistoryTarget,
    distroKey: string,
    key: string
  ): Promise<void> {
    // Quit doesn't await history work, so a pass queued before it must not start guest work.
    if (isCodexAccountHistoryWorkStopping()) {
      return
    }
    if (this.settledThisRun.get(key) === target.shared) {
      this.retryFailedHeal(distroKey)
      return
    }
    this.settledThisRun.delete(key)
    this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 0) + 1)
    this.startedPasses.set(distroKey, (this.startedPasses.get(distroKey) ?? 0) + 1)
    try {
      const output = await linkInGuest(target, this.dependencies)
      if (output && output.result === (target.shared ? 'shared' : 'unshared')) {
        this.settledThisRun.set(key, target.shared)
      }
      if (output && output.pending.length > 0) {
        this.oweHeal(distroKey, { target, output })
      }
      if (target.shared && (output?.result === 'shared' || output?.result === 'incomplete')) {
        this.owedChecks.set(key, { ...target })
      }
    } finally {
      this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 1) - 1)
      this.startOwedHeal(distroKey)
      this.startOwedCheck(distroKey)
    }
  }

  // Passes in one distro share its marker folder and may report in any order: keep every name.
  private oweHeal(
    distroKey: string,
    owed: { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  ): void {
    const earlier = this.owedHeals.get(distroKey)?.output.pending ?? []
    const pending = [...new Set([...earlier, ...owed.output.pending])]
    this.owedHeals.set(distroKey, { ...owed, output: { ...owed.output, pending } })
  }

  private retryFailedHeal(distroKey: string): void {
    const failed = this.failedHeals.get(distroKey)
    if (failed) {
      this.failedHeals.delete(distroKey)
      this.oweHeal(distroKey, failed)
      this.startOwedHeal(distroKey)
    }
  }

  // A pass may have recorded markers for files not moved yet, which a read would settle as missing.
  private startOwedHeal(distroKey: string): void {
    const isPaused = (): boolean => (this.activePasses.get(distroKey) ?? 0) > 0
    const owed = this.owedHeals.get(distroKey)
    if (!owed || isPaused() || this.heals.has(distroKey) || isCodexAccountHistoryWorkStopping()) {
      return
    }
    this.owedHeals.delete(distroKey)
    const started = this.startedPasses.get(distroKey) ?? 0
    const heal = healInGuest(owed.target, owed.output, this.dependencies, {
      isPaused,
      startedSince: () => (this.startedPasses.get(distroKey) ?? 0) !== started
    })
      .then((finished) => {
        if (!finished) {
          this.failedHeals.set(distroKey, owed)
        }
      })
      .catch((error: unknown) => {
        console.warn('[codex-account-history] Indexing WSL shared history failed:', error)
        this.failedHeals.set(distroKey, owed)
      })
      .finally(() => {
        this.heals.delete(distroKey)
        this.startOwedHeal(distroKey)
      })
    this.heals.set(distroKey, heal)
  }

  // Detached: hashing a large history must not hold up a launch's pass.
  private startOwedCheck(distroKey: string): void {
    if (
      this.checks.has(distroKey) ||
      (this.activePasses.get(distroKey) ?? 0) > 0 ||
      isCodexAccountHistoryWorkStopping()
    ) {
      return
    }
    const owed = [...this.owedChecks].find(
      ([, target]) => target.distro.toLowerCase() === distroKey
    )
    if (!owed) {
      return
    }
    const [key, target] = owed
    this.checks.add(distroKey)
    // An unfinished check resumes on a later launch, never in a loop now.
    // A pass that finished meanwhile owes a fresh check; only this run's request is settled.
    const settle = (): void => {
      if (this.owedChecks.get(key) === target) {
        this.owedChecks.delete(key)
      }
    }
    void checkInGuest(target, this.dependencies)
      .then(settle)
      .catch((error: unknown) => {
        settle()
        console.warn('[codex-account-history] Checking WSL left-behind history failed:', error)
      })
      .finally(() => {
        this.checks.delete(distroKey)
        this.startOwedCheck(distroKey)
      })
  }
}
