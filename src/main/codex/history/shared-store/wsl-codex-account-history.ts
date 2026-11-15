import { posix as pathPosix } from 'node:path'
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
import { CODEX_INDEX_PENDING_DIR } from './codex-account-history-links'

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

const runningPasses = new Map<string, Promise<boolean>>()

/**
 * Links (or, with sharing off, unlinks) a WSL account home inside its distro, then indexes moved
 * history; resolves to whether the home's history now lives in the store.
 */
export function startWslCodexAccountHistoryInBackground(
  target: WslCodexAccountHistoryTarget,
  dependenciesOverride: Partial<WslAccountHistoryDependencies> = {}
): Promise<boolean> {
  if (isCodexAccountHistoryWorkStopping()) {
    return Promise.resolve(false)
  }
  const key = `${target.distro.toLowerCase()}\0${target.accountHome}`
  const running = runningPasses.get(key)
  if (running) {
    return running
  }
  const pass = runPass(target, { ...defaultDependencies, ...dependenciesOverride })
    .catch((error: unknown) => {
      console.warn('[codex-account-history] WSL account history pass failed:', error)
      return false
    })
    .finally(() => runningPasses.delete(key))
  runningPasses.set(key, pass)
  return pass
}

async function runPass(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<boolean> {
  // Every wsl.exe step re-checks: the user may stop the distro mid-pass, and a step would boot it.
  const requireRunning = (): Promise<void> => dependencies.requireRunning(target.distro)
  await requireRunning()
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: [target.shared ? 'share' : 'unshare', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    maxOutputBytes: HELPER_MAX_OUTPUT_BYTES
  })
  const { linked, pending } = parseHelperOutput(stdout)
  if (pending.length === 0 || isCodexAccountHistoryWorkStopping()) {
    return linked
  }
  const distroKey = target.distro.toLowerCase()
  let distroStopped = false
  const unsubscribe = dependencies.subscribeStops((stopped) => {
    distroStopped ||= stopped.some((distro) => distro.toLowerCase() === distroKey)
  })
  const stillRunning = async (): Promise<void> => {
    await requireRunning().catch((error: unknown) => {
      distroStopped = true
      throw error
    })
  }
  try {
    await healCodexIndexPendingRollouts({
      storeHome: target.storeHome,
      rolloutNames: pending,
      clear: async (names) => {
        await stillRunning()
        await clearPendingMarkers(target, names)
      },
      options: {
        // Windows can't take SQLite's locks over \\wsl.localhost; the guest's own codex indexes.
        buildInvocation: (_home, timeoutMs) =>
          buildWslHealInvocation(target.distro, target.storeHome, timeoutMs),
        runSession: async (invocation, body) => {
          await stillRunning()
          return runCodexAppServerSession(invocation, body)
        },
        shouldStop: () => distroStopped
      }
    })
  } finally {
    unsubscribe()
  }
  return linked
}

/** Marker lines precede the summary; a missing summary means the list may be clipped. */
function parseHelperOutput(stdout: string): { linked: boolean; pending: string[] } {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let result: unknown
  try {
    const summary: unknown = JSON.parse(lines.at(-1) ?? '')
    result = summary && typeof summary === 'object' && 'result' in summary ? summary.result : null
  } catch {
    result = null
  }
  if (result === null) {
    return { linked: false, pending: [] }
  }
  // Login scripts may print before the helper; only rollout names are markers.
  return {
    linked: result === 'shared',
    pending: lines.slice(0, -1).filter((line) => line.startsWith('rollout-'))
  }
}

async function clearPendingMarkers(
  target: WslCodexAccountHistoryTarget,
  names: readonly string[]
): Promise<void> {
  if (names.length === 0) {
    return
  }
  const result = await runWslProcess({
    distro: target.distro,
    loginPath: 'none',
    script: 'cd -- "$1" || exit 1\nshift\nrm -f -- "$@"',
    args: [pathPosix.join(target.accountHome, CODEX_INDEX_PENDING_DIR), ...names],
    timeoutMs: CLEAR_TIMEOUT_MS
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Could not clear WSL Codex index markers (code ${result.code})`)
  }
}

/** One guest loop per distro, launched home first; remembers which homes ended up linked. */
export class WslCodexAccountHistoryLaunches {
  private readonly loops = new Map<string, Promise<void>>()
  // Distro and Linux path -> whether the last guest pass left the home's history in the store.
  private readonly linked = new Map<string, boolean>()

  start(args: {
    distro: string
    launchedHome: string
    accountHomes: readonly string[]
    storeHome: string
    shared: boolean
  }): void {
    const distroKey = args.distro.toLowerCase()
    if (args.accountHomes.length === 0 || this.loops.has(distroKey)) {
      return
    }
    const ordered = [
      ...args.accountHomes.filter((home) => home === args.launchedHome),
      ...args.accountHomes.filter((home) => home !== args.launchedHome)
    ]
    const loop = (async () => {
      for (const accountHome of ordered) {
        const linked = await startWslCodexAccountHistoryInBackground({
          distro: args.distro,
          accountHome,
          storeHome: args.storeHome,
          shared: args.shared
        })
        this.linked.set(`${distroKey}\0${accountHome}`, linked)
      }
    })().finally(() => this.loops.delete(distroKey))
    this.loops.set(distroKey, loop)
  }

  /** Before this run's first guest pass for the home, the config keeps what it had. */
  sqliteHome(distro: string, accountHome: string, storeHome: string): string | null | undefined {
    const linked = this.linked.get(`${distro.toLowerCase()}\0${accountHome}`)
    return linked === undefined ? undefined : linked ? storeHome : null
  }
}
