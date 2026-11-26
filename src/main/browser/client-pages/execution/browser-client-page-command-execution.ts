import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR,
  requiresBrowserClientFileChannel
} from '../../../../shared/browser/client-hosting/browser-client-file-channel-methods'
import { AGENT_DOWNLOAD_START_TIMEOUT_MS } from '../../../../shared/browser/downloads/agent-download-timing'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser/navigation/browser-url'
import { executeBrowserClientUploadCommand } from '../../client-hosts/file-transfers/browser-client-upload-command'
import type { BrowserClientPageCommandExecutorDependencies } from './browser-client-page-command-executor-dependencies'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer
} from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import { browserClientPageDesktopDataRefusal } from './browser-client-page-desktop-data-refusal'
import { sameBrowserClientPageAuthority } from '../../client-hosts/commands/browser-client-host-command-authority'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from '../lifecycle/browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from '../lifecycle/browser-client-page-inventory'

export async function navigateBrowserClientPageCommand(
  pages: Map<string, BrowserClientRetainedPage>,
  routeWebContents: BrowserClientPageLifecycleRegistry,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.command.type !== 'navigate') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = requireCommandPage(pages, event)
  assertBrowserClientPageCommandNotAborted(signal)
  assertCurrentBrowserClientPageRenderer(page.renderer)
  const normalized = normalizeBrowserNavigationUrl(event.command.url)
  if (!normalized || normalized.startsWith('file:')) {
    throw new BrowserClientPageCommandError('browser_client_page_navigation_invalid')
  }
  const navigated = await routeWebContents.navigateGuest(page.lifecycleClaim, normalized)
  if (!navigated) {
    throw new BrowserClientPageCommandError('browser_client_page_navigation_failed')
  }
  page.inventory = updateBrowserClientPageInventoryCurrentUrl(page.inventory, normalized)
}

export async function executeBrowserClientPageAutomationCommand(
  pages: Map<string, BrowserClientRetainedPage>,
  execute: (
    input: {
      browserPageId: string
      pageHostGeneration: number
      browserProfileId: string
      method: BrowserClientAutomationMethod
      params: Record<string, unknown>
      agent: boolean
      registration: BrowserClientRetainedPage['registration']
    },
    signal: AbortSignal
  ) => Promise<unknown>,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal,
  files: Pick<
    BrowserClientPageCommandExecutorDependencies,
    'fileChannel' | 'uploadStaging' | 'claimRelayedDownload'
  > = {}
): Promise<unknown> {
  if (event.command.type !== 'automation') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = requireCommandPage(pages, event)
  assertBrowserClientPageCommandNotAborted(signal)
  assertCurrentBrowserClientPageRenderer(page.renderer)
  const method = event.command.method
  refuseDesktopFileAccess(method, event.command.params)
  // An older server still forwards these; refuse with the sentence a newer one gives up front.
  const dataRefusal = browserClientPageDesktopDataRefusal(method, event.command.params)
  if (dataRefusal) {
    throw new BrowserClientPageCommandError(dataRefusal.code, { detail: dataRefusal.message })
  }
  const agent = event.command.agent !== false
  const run = (
    params: Record<string, unknown>,
    runMethod: BrowserClientAutomationMethod = method
  ): Promise<unknown> =>
    execute(
      {
        browserPageId: event.browserPageId,
        pageHostGeneration: event.pageHostGeneration,
        browserProfileId: page.inventory.browserProfileId,
        method: runMethod,
        params,
        agent,
        registration: page.registration
      },
      signal
    )
  if (!requiresBrowserClientFileChannel(method)) {
    return run(event.command.params)
  }
  if (method === 'browser.download') {
    const { selector, path, ...target } = event.command.params
    // An older host names a path on its own disk; never resolve it on the desktop.
    if (path !== undefined) {
      throw new BrowserClientPageCommandError('browser_client_download_path_unsupported', {
        detail:
          'download is not available for this page because it is shown on the paired desktop: the file would be saved there, not on this host.'
      })
    }
    if (!files.fileChannel?.available || !files.claimRelayedDownload) {
      throw new BrowserClientPageCommandError(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
    }
    // Only the click runs here: the download relay hands the file to the host, which saves it.
    const intent = files.claimRelayedDownload(page.registration.webContentsId)
    try {
      await run({ ...target, element: selector }, 'browser.click')
      const downloadStarted = await withTimeout(
        intent.started.then(() => true),
        AGENT_DOWNLOAD_START_TIMEOUT_MS,
        false
      )
      return { downloadStarted }
    } finally {
      intent.release()
    }
  }
  return executeBrowserClientUploadCommand({
    event,
    params: event.command.params,
    fileChannel: files.fileChannel,
    staging: files.uploadStaging,
    run
  })
}

// Commands come from the page's runtime, so a path or file: URL must never name this desktop's files.
function refuseDesktopFileAccess(
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>
): void {
  if (method === 'browser.exec') {
    throw new BrowserClientPageCommandError('browser_client_exec_unsupported', {
      detail:
        'exec is not available for this page because it is shown on the paired desktop: raw commands and their file paths would run there, not on this host. Use the typed browser commands instead, such as a plain snapshot for page text.'
    })
  }
  if (method === 'browser.goto' && typeof params.url === 'string') {
    const normalized = normalizeBrowserNavigationUrl(params.url)
    if (normalized?.startsWith('file:')) {
      throw new BrowserClientPageCommandError('browser_client_page_navigation_invalid', {
        detail:
          'This page cannot open file: URLs because it is shown on the paired desktop: the file would be read there, not on this host.'
      })
    }
  }
}

function requireCommandPage(
  pages: Map<string, BrowserClientRetainedPage>,
  event: BrowserClientHostCommandEvent
): BrowserClientRetainedPage {
  const page = pages.get(event.browserPageId)
  if (
    !page ||
    page.generation !== event.pageHostGeneration ||
    page.retiring ||
    page.reconciling ||
    !sameBrowserClientPageAuthority(page.inventory, event)
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
  }
  return page
}
