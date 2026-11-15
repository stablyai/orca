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

const runningPasses = new Map<string, Promise<void>>()

/** Links (or, with sharing off, unlinks) a WSL account home inside its distro, then indexes moved history. */
export function startWslCodexAccountHistoryInBackground(
  target: WslCodexAccountHistoryTarget,
  dependenciesOverride: Partial<WslAccountHistoryDependencies> = {}
): Promise<void> {
  if (isCodexAccountHistoryWorkStopping()) {
    return Promise.resolve()
  }
  const key = `${target.distro.toLowerCase()}\0${target.accountHome}`
  const running = runningPasses.get(key)
  if (running) {
    return running
  }
  const pass = runPass(target, { ...defaultDependencies, ...dependenciesOverride })
    .catch((error: unknown) => {
      console.warn('[codex-account-history] WSL account history pass failed:', error)
    })
    .finally(() => runningPasses.delete(key))
  runningPasses.set(key, pass)
  return pass
}

async function runPass(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<void> {
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
  const pending = parsePendingRollouts(stdout)
  if (pending.length === 0 || isCodexAccountHistoryWorkStopping()) {
    return
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
}

/** Marker lines precede the summary; a missing summary means the list may be clipped. */
function parsePendingRollouts(stdout: string): string[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  try {
    const summary: unknown = JSON.parse(lines.at(-1) ?? '')
    if (!summary || typeof summary !== 'object' || !('result' in summary)) {
      return []
    }
  } catch {
    return []
  }
  // Login scripts may print before the helper; only rollout names are markers.
  return lines.slice(0, -1).filter((line) => line.startsWith('rollout-'))
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
