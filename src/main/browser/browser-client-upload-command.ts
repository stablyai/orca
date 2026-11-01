import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../shared/browser-client-file-channel-methods'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import type { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import type { BrowserClientUploadStaging } from './browser-client-upload-staging'
import {
  fetchBrowserClientUploadFiles,
  readBrowserClientUploadPaths
} from './browser-client-upload-transfer'

/** Keep staged files after success because Chromium opens file-input paths lazily. */
export async function executeBrowserClientUploadCommand(options: {
  event: BrowserClientHostCommandEvent
  params: Record<string, unknown>
  fileChannel: BrowserClientFileChannelTransport | undefined
  staging: BrowserClientUploadStaging | undefined
  run(params: Record<string, unknown>): Promise<unknown>
}): Promise<unknown> {
  const { fileChannel, staging } = options
  if (!fileChannel?.available || !staging) {
    throw new BrowserClientPageCommandError(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
  }
  const remotePaths = readBrowserClientUploadPaths(options.params)
  const files = await fetchBrowserClientUploadFiles({
    request: (method, params) => fileChannel.request(method, params),
    event: options.event,
    remotePaths
  })
  const staged = await staging.stage({
    browserPageId: options.event.browserPageId,
    pageHostGeneration: options.event.pageHostGeneration,
    files
  })
  files.length = 0
  try {
    return await options.run({ ...options.params, files: [...staged.localFilePaths] })
  } catch (error) {
    // Preserve the upload error; failed cleanup remains recorded for a later retry.
    await staging.release(staged.stagingId).catch(() => undefined)
    throw error
  }
}
