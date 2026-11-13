import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES,
  BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES,
  truncateBrowserClientAutomationErrorMessage,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { browserHostCommandResultIdentity } from './browser-host-command-result-submission'

const BROWSER_HOST_COMMAND_RESULT_TOO_LARGE_CODE = 'browser_host_command_result_too_large'

/** Sends an automation value too big for one result frame to the host ahead of its settlement. */
export async function stageBrowserHostCommandResult(
  command: BrowserClientHostCommandEvent,
  result: BrowserClientHostCommandResult,
  sendChunk: (params: unknown) => Promise<void>,
  signal: AbortSignal
): Promise<BrowserClientHostCommandResult> {
  if (
    result.status !== 'completed' ||
    result.value === undefined ||
    command.command.type !== 'automation'
  ) {
    return result
  }
  const bytes = Buffer.from(JSON.stringify(result.value), 'utf8')
  const hostStages = command.command.stagedResults === true
  if (
    bytes.byteLength <= BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES ||
    (!hostStages && bytes.byteLength <= BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES)
  ) {
    return result
  }
  if (!hostStages || bytes.byteLength > BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES) {
    const limit = hostStages
      ? BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES
      : BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES
    return failed(
      BROWSER_HOST_COMMAND_RESULT_TOO_LARGE_CODE,
      `The result (${formatMegabytes(bytes.byteLength)}) is larger than the ${formatMegabytes(limit)} this server accepts from a page on this device. Use --format jpeg, a selector, or a smaller viewport${hostStages ? '' : ', or update the server'}.`
    )
  }
  const identity = browserHostCommandResultIdentity(command)
  try {
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES
    ) {
      if (signal.aborted) {
        return failed('browser_client_page_command_aborted')
      }
      const chunk = bytes.subarray(
        offset,
        offset + BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES
      )
      await sendChunk({ ...identity, offset, contentBase64: chunk.toString('base64') })
    }
  } catch (error) {
    // Keep the host or transport code (e.g. too large, unavailable) so the agent sees why.
    return failed(
      error instanceof RemoteRuntimeClientError
        ? error.code
        : 'browser_host_command_result_staging_failed',
      error instanceof Error ? error.message : String(error)
    )
  }
  return { status: 'completed', stagedValueBytes: bytes.byteLength }
}

function failed(errorCode: string, message?: string): BrowserClientHostCommandResult {
  const errorMessage = message ? truncateBrowserClientAutomationErrorMessage(message) : undefined
  return { status: 'failed', errorCode, ...(errorMessage ? { errorMessage } : {}) }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
