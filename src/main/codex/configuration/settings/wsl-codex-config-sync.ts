import { WSL_CODEX_CONFIG_SYNC_HELPER_FILENAME } from '../../../../shared/remote-runtime/orcad-distribution/remote-bundle-artifacts'
import { runWslGuestNodeHelper } from '../../../wsl/execution/wsl-guest-node-helper'
import {
  assertWslUncPathRunning,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import { CodexHistoryPassQueue } from '../../history/shared-store/codex-history-pass-queue'
import { reportCodexConfigSyncOutcome } from './config-sync-stall'
import type { CodexConfigSyncStatus } from '../../../../shared/agent-accounts/codex/codex-config-sync-types'
import {
  CODEX_CONFIG_SYNC_WSL_PROTOCOL,
  type CodexConfigSyncWslHomeResult,
  type CodexConfigSyncWslOutput
} from './codex-config-sync-wsl-protocol'

const HELPER_TIMEOUT_MS = 20_000

export type WslCodexConfigSyncHome = {
  /** Host spelling (\\wsl.localhost\…), the key the stall latch uses. */
  runtimeHomePath: string
  linuxRuntimeHome: string
}

// One pass at a time per distro, so a launch and a background pass never race on the same files.
// A distro's queue is dropped once its last pass ends, so removed distros leave nothing behind.
const queues = new Map<string, { queue: CodexHistoryPassQueue; passes: number }>()
type WaitingPass = { forLaunch: boolean; pass?: Promise<void>; replacedBy?: WaitingPass }
// Passes queued but not started, by distro and home set: a request joins one, since it will read
// the files after the request was made. A pass that started needs a new run for later requests.
const waiting = new Map<string, WaitingPass>()

/**
 * Runs the settings sync inside the distro, where every read and rename stays on its own file
 * system. A launch (a user act) may start the distro; a background pass never does (E9). Never
 * throws: a failed pass leaves the baseline, so pending tab edits promote on the next one.
 */
export function syncWslCodexConfigInDistro(args: {
  distro: string
  linuxSystemHome: string
  homes: readonly WslCodexConfigSyncHome[]
  forLaunch: boolean
}): Promise<void> {
  if (args.homes.length === 0) {
    return Promise.resolve()
  }
  const distroKey = args.distro.toLowerCase()
  const homeSetKey = [
    distroKey,
    args.linuxSystemHome,
    ...args.homes.map((home) => home.linuxRuntimeHome).sort()
  ].join('\0')
  const queuedPass = waiting.get(homeSetKey)
  // A launch never waits behind a queued background pass's place in line.
  if (queuedPass?.pass && (queuedPass.forLaunch || !args.forLaunch)) {
    return queuedPass.pass
  }
  const distroQueue = queues.get(distroKey) ?? { queue: new CodexHistoryPassQueue(), passes: 0 }
  queues.set(distroKey, distroQueue)
  distroQueue.passes++
  // Registered before queueing: an idle queue starts the job at once.
  const entry: WaitingPass = { forLaunch: args.forLaunch }
  waiting.set(homeSetKey, entry)
  if (queuedPass) {
    // The launch pass runs first and reads the files later, so it serves this one's waiters too.
    queuedPass.replacedBy = entry
  }
  const ran = distroQueue.queue.add(
    async () => {
      if (entry.replacedBy) {
        return false
      }
      if (waiting.get(homeSetKey) === entry) {
        waiting.delete(homeSetKey)
      }
      await runPass(args)
      return true
    },
    { forLaunch: args.forLaunch }
  )
  void ran
    .finally(() => {
      if (--distroQueue.passes === 0 && queues.get(distroKey) === distroQueue) {
        queues.delete(distroKey)
      }
    })
    .catch(() => {})
  // Chained outside the queue: a replaced pass waiting inside it would hold up the distro.
  entry.pass = ran.then((done) => (done ? undefined : entry.replacedBy?.pass))
  return entry.pass
}

async function runPass({
  distro,
  linuxSystemHome,
  homes,
  forLaunch
}: Parameters<typeof syncWslCodexConfigInDistro>[0]): Promise<void> {
  let stdout: string
  try {
    stdout = await runWslGuestNodeHelper({
      distro,
      helperFilename: WSL_CODEX_CONFIG_SYNC_HELPER_FILENAME,
      helperLabel: 'Codex settings sync',
      helperArgs: [
        'sync',
        '--system-home',
        linuxSystemHome,
        ...homes.flatMap((home) => ['--runtime-home', home.linuxRuntimeHome]),
        '--protocol',
        String(CODEX_CONFIG_SYNC_WSL_PROTOCOL)
      ],
      timeoutMs: HELPER_TIMEOUT_MS,
      requireRunning: forLaunch ? undefined : () => assertWslUncPathRunning('', distro)
    })
  } catch (error) {
    if (!(error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError)) {
      console.warn(
        `[codex-config] Codex settings sync in WSL ${distro} did not run; tab edits stay pending:`,
        error
      )
    }
    return
  }
  const results = parseOutput(stdout)
  if (!results) {
    console.warn(`[codex-config] Codex settings sync in WSL ${distro} gave no result`)
    return
  }
  const resultsByHome = new Map<string, CodexConfigSyncWslHomeResult>()
  for (const result of results) {
    if (!resultsByHome.has(result.runtimeHome)) {
      resultsByHome.set(result.runtimeHome, result)
    }
  }
  for (const home of homes) {
    const result = resultsByHome.get(home.linuxRuntimeHome)
    if (!result) {
      continue
    }
    if (!result.complete) {
      for (const warning of result.warnings) {
        console.warn(`[codex-config] WSL ${distro}: ${warning}`)
      }
    }
    reportCodexConfigSyncOutcome(
      home.runtimeHomePath,
      result.status,
      result.error === null ? undefined : new Error(result.error)
    )
  }
}

// Login scripts may print before the helper, so only the last line is its result.
function parseOutput(stdout: string): CodexConfigSyncWslHomeResult[] | null {
  let output: unknown
  try {
    output = JSON.parse(stdout.split(/\r?\n/).at(-1) ?? '')
  } catch {
    return null
  }
  return isHelperOutput(output) ? output.homes : null
}

function isHelperOutput(value: unknown): value is CodexConfigSyncWslOutput {
  return (
    !!value &&
    typeof value === 'object' &&
    'protocol' in value &&
    value.protocol === CODEX_CONFIG_SYNC_WSL_PROTOCOL &&
    'homes' in value &&
    Array.isArray(value.homes) &&
    value.homes.every(isHomeResult)
  )
}

// A malformed entry takes the "gave no result" path instead of throwing after the helper ran.
function isHomeResult(value: unknown): value is CodexConfigSyncWslHomeResult {
  return (
    !!value &&
    typeof value === 'object' &&
    'runtimeHome' in value &&
    typeof value.runtimeHome === 'string' &&
    'complete' in value &&
    typeof value.complete === 'boolean' &&
    'status' in value &&
    isSyncStatus(value.status) &&
    'error' in value &&
    (value.error === null || typeof value.error === 'string') &&
    'warnings' in value &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string')
  )
}

const STALL_REASONS: readonly unknown[] = [
  'missing-source',
  'blank-source',
  'unreadable-source',
  'managed-home-unavailable'
]

function isSyncStatus(value: unknown): value is CodexConfigSyncStatus {
  if (
    !value ||
    typeof value !== 'object' ||
    !('systemConfigPath' in value) ||
    typeof value.systemConfigPath !== 'string' ||
    !('state' in value) ||
    !('reason' in value)
  ) {
    return false
  }
  if (value.state === 'synced') {
    return value.reason === null
  }
  return (
    value.state === 'stalled' &&
    STALL_REASONS.includes(value.reason) &&
    (!('managedStatePath' in value) ||
      value.managedStatePath === undefined ||
      typeof value.managedStatePath === 'string')
  )
}
