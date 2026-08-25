import type { RemoteServerUpdaterSnapshot } from '../../shared/remote-server-update'
import type { UpdateStatus } from '../../shared/update-status-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import type { RuntimeClient } from '../runtime-client'
import {
  formatAppVersion,
  formatUpdateProgress,
  formatUpdateResult,
  type UpdateCommandResult
} from '../update-format'

const CHECK_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const STATUS_WAIT_SLICE_MS = 25_000

type PollResult = {
  response: RuntimeRpcSuccess<RemoteServerUpdaterSnapshot>
  timedOut: boolean
}

/**
 * CLI handlers for `orca version` and `orca update`. All work is delegated to the
 * running desktop app over RPC — the CLI only drives and reports on the flow.
 */
export const UPDATER_HANDLERS: Record<string, CommandHandler> = {
  /** `orca version` — reports the running app's version. */
  version: async ({ client, json }) => {
    const response = await withUpdaterRecovery(() => client.getUpdateStatus())
    const versionResponse: RuntimeRpcSuccess<{ version: string }> = {
      ...response,
      result: { version: response.result.appVersion }
    }
    printResult(versionResponse, json, formatAppVersion)
  },
  /**
   * `orca update [--check] [--prerelease]` — checks for an update and, unless
   * `--check`, downloads and installs it (attaching to any in-progress download).
   */
  update: async ({ client, flags, json }) => {
    const checkOnly = flags.get('check') === true
    if (!json) {
      console.log('Checking for Orca updates...')
    }

    // Why: getStatus never rejects on support grounds, so read it first — this
    // surfaces headless-serve/dev/unavailable cases with guidance instead of the
    // check/download/install RPCs throwing `remote_update_manual_required`.
    const initial = await withUpdaterRecovery(() => client.getUpdateStatus())
    if (!initial.result.support.automatic) {
      finishUpdateCommand(initial, json, {
        operation: checkOnly ? 'check' : 'update',
        installRequested: false,
        timedOut: false
      })
      return
    }

    const initialCheck = await withUpdaterRecovery(() =>
      client.checkForUpdate(flags.get('prerelease') === true)
    )
    const check = await waitForStatus(
      client,
      initialCheck,
      // Why: 'downloading'/'downloaded' are terminal for the check phase too — a
      // download may already be in flight (e.g. started from the desktop UI), so
      // surface it immediately instead of waiting until the check-phase timeout.
      (status) =>
        status.state === 'available' ||
        status.state === 'not-available' ||
        status.state === 'error' ||
        status.state === 'downloading' ||
        status.state === 'downloaded',
      CHECK_TIMEOUT_MS
    )

    const checkStatus = check.response.result.status
    const downloadInProgress =
      checkStatus.state === 'downloading' || checkStatus.state === 'downloaded'

    if (checkOnly || check.timedOut || (checkStatus.state !== 'available' && !downloadInProgress)) {
      finishUpdateCommand(check.response, json, {
        operation: checkOnly ? 'check' : 'update',
        installRequested: false,
        timedOut: check.timedOut
      })
      return
    }

    if (!json && checkStatus.state === 'available') {
      console.log(`Update available: Orca ${checkStatus.version}. Downloading...`)
    }
    // Why: attach to an existing download rather than kicking off a redundant one.
    const initialDownload =
      checkStatus.state === 'available'
        ? await withUpdaterRecovery(() => client.downloadUpdate())
        : check.response
    let lastProgress = ''
    let ttyProgressLineActive = false
    const download = await waitForStatus(
      client,
      initialDownload,
      (status) => status.state === 'downloaded' || status.state === 'error',
      DOWNLOAD_TIMEOUT_MS,
      (status) => {
        if (json) {
          return
        }
        const progress = formatUpdateProgress(status)
        if (process.stdout.isTTY === true) {
          if (status.state === 'downloading' && progress) {
            process.stdout.write(`\r${progress}`)
            ttyProgressLineActive = true
          } else if (ttyProgressLineActive) {
            process.stdout.write('\n')
            ttyProgressLineActive = false
          }
          return
        }
        if (progress && progress !== lastProgress) {
          console.log(progress)
          lastProgress = progress
        }
      }
    )
    // Why: timeouts can end a wait without a terminal updater state; close any
    // in-place TTY line before final output.
    if (ttyProgressLineActive) {
      process.stdout.write('\n')
    }

    if (download.timedOut || download.response.result.status.state !== 'downloaded') {
      finishUpdateCommand(download.response, json, {
        operation: 'update',
        installRequested: false,
        timedOut: download.timedOut
      })
      return
    }

    await withUpdaterRecovery(() => client.installUpdate())
    finishUpdateCommand(download.response, json, {
      operation: 'update',
      installRequested: true,
      timedOut: false
    })
  }
}

/**
 * Waits for updater status events until `isTerminal` matches or the phase timeout
 * expires, invoking `onStatus` for the initial response and each changed status.
 * Uses revision-based long-polls so it stays efficient over local and remote runtimes.
 */
async function waitForStatus(
  client: RuntimeClient,
  initialResponse: RuntimeRpcSuccess<RemoteServerUpdaterSnapshot>,
  isTerminal: (status: UpdateStatus) => boolean,
  timeoutMs: number,
  onStatus?: (status: UpdateStatus) => void
): Promise<PollResult> {
  let response = initialResponse
  onStatus?.(response.result.status)
  if (isTerminal(response.result.status)) {
    return { response, timedOut: false }
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Why: read the clock once and break on non-positive remaining time — a
    // separate condition read could let the slice reach updater.wait as 0/negative,
    // which its `min(1)` param validation rejects as an RPC error, not a timeout.
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      break
    }
    const next = await withUpdaterRecovery(() =>
      client.waitForUpdateStatus(
        response.result.revision,
        Math.min(STATUS_WAIT_SLICE_MS, remainingMs)
      )
    )
    response = {
      ...next,
      result: {
        appVersion: next.result.appVersion,
        runtimeId: next.result.runtimeId,
        support: next.result.support,
        status: next.result.status,
        revision: next.result.revision
      }
    }
    if (next.result.timedOut) {
      continue
    }
    onStatus?.(response.result.status)
    if (isTerminal(response.result.status)) {
      return { response, timedOut: false }
    }
  }
  return { response, timedOut: true }
}

/**
 * Prints the terminal outcome of `orca update` and sets a failing exit code when
 * the run timed out or ended in an updater error.
 */
function finishUpdateCommand(
  response: RuntimeRpcSuccess<RemoteServerUpdaterSnapshot>,
  json: boolean,
  details: Omit<UpdateCommandResult, 'status' | 'support'>
): void {
  const snapshot = response.result
  const result: RuntimeRpcSuccess<UpdateCommandResult> = {
    ...response,
    result: { ...details, status: snapshot.status, support: snapshot.support }
  }
  if (details.timedOut || snapshot.status.state === 'error') {
    process.exitCode = 1
  }
  printResult(result, json, formatUpdateResult)
}

/**
 * Runs an updater RPC call, translating an unreachable-app error into a
 * `runtime_unavailable` error carrying actionable, platform-aware next steps.
 */
async function withUpdaterRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || error.code !== 'runtime_unavailable') {
      throw error
    }
    const nextSteps = [
      'Open Orca, then retry the command.',
      'Download the latest Orca release from https://onorca.dev/download.'
    ]
    if (process.platform === 'darwin') {
      nextSteps.splice(1, 0, "If Orca was installed with Homebrew, run 'brew upgrade --cask orca'.")
    }
    throw new RuntimeClientError('runtime_unavailable', "Could not reach Orca's desktop updater.", {
      nextSteps
    })
  }
}
