import { WSL_CODEX_CONFIG_SYNC_HELPER_FILENAME } from '../../../../shared/remote-runtime/orcad-distribution/remote-bundle-artifacts'
import { runWslGuestNodeHelper } from '../../../wsl/execution/wsl-guest-node-helper'
import {
  assertWslUncPathRunning,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import { CodexHistoryPassQueue } from '../../history/shared-store/codex-history-pass-queue'
import { reportCodexConfigSyncOutcome } from './config-sync-stall'
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
const queues = new Map<string, CodexHistoryPassQueue>()

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
  const key = args.distro.toLowerCase()
  const queue = queues.get(key) ?? new CodexHistoryPassQueue()
  queues.set(key, queue)
  return queue.add(() => runPass(args), { forLaunch: args.forLaunch })
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
  for (const home of homes) {
    const result = results.find((candidate) => candidate.runtimeHome === home.linuxRuntimeHome)
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

// The bundle comes from the running install, so a matching protocol vouches for the home shape.
function isHelperOutput(value: unknown): value is CodexConfigSyncWslOutput {
  return (
    !!value &&
    typeof value === 'object' &&
    'protocol' in value &&
    value.protocol === CODEX_CONFIG_SYNC_WSL_PROTOCOL &&
    'homes' in value &&
    Array.isArray(value.homes)
  )
}
