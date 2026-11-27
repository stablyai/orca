import { redactClientBrowserAutomationResult } from './browser-client-automation-result-metadata'
import { browserClientNavigationFailure } from './browser-client-navigation-failure'
import { redactBrowserMetadata } from '../../../../shared/browser/browser-metadata-redaction'
import { actOnRuntimeBrowserInitialization } from './runtime-browser-page-initialization-action'
import { isSameBrowserUrl } from '../../../../shared/browser/client-hosting/browser-expected-url'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { BrowserError } from '../../../browser/browser-error'
import { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  browserClientPageRefusal,
  readableBrowserClientPageRefusal
} from './browser-client-page-refusal-copy'
import { browserExpectedUrlMismatchError } from '../../../browser/cdp/input/browser-expected-page-url'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'
import { isAgentRpcCaller, type RpcCallerIdentity } from '../../rpc/callers/rpc-caller-identity'
import { isWindowsAbsolutePathLike } from '../../../../shared/file-access/cross-platform-path'
import { grantClientPageUploadReads } from './client-page-upload-reads'
import { downloadClientPageToPath } from './client-page-download-to-path'
import { browserClientPageDesktopDataRefusal } from '../../../browser/client-pages/execution/browser-client-page-desktop-data-refusal'

export type ClientHostedBrowserRpcRoute = { handled: false } | { handled: true; result: unknown }

type ClientAutomationRoute = {
  method: string
  params: unknown
  caller: RpcCallerIdentity | undefined
  pages: RuntimeBrowserPageRegistry
  leases: BrowserHostLeaseRegistry
  resolveExecutionHostKey?(workspaceId: string): Promise<BrowserExecutionHostKeyResolution>
  notifyWorkspace?(workspaceId: string): void
  resolveWorkspace(selector: string): Promise<{ id: string }>
}

export async function routeRuntimeBrowserClientAutomation(
  options: ClientAutomationRoute
): Promise<ClientHostedBrowserRpcRoute> {
  const method = BrowserClientAutomationMethod.safeParse(options.method)
  if (!method.success || !isRecord(options.params)) {
    return { handled: false }
  }
  const page = await resolveTargetPage(options.params, options.pages, options.resolveWorkspace)
  if (!page) {
    return { handled: false }
  }
  // Refused here so an older desktop, which would run them, never receives them.
  const dataRefusal = browserClientPageDesktopDataRefusal(method.data, options.params)
  if (dataRefusal) {
    throw new BrowserError(dataRefusal.code, dataRefusal.message)
  }
  const agent = isAgentRpcCaller(options.caller)
  // A person's tab pick waits while the agent drives this page.
  const settle = agent ? options.pages.agentUse.begin(page.browserPageId) : undefined
  try {
    return await runOnClientPage(options, method.data, options.params, page, agent)
  } finally {
    settle?.()
  }
}

async function runOnClientPage(
  options: ClientAutomationRoute,
  method: BrowserClientAutomationMethod,
  requestParams: Record<string, unknown>,
  page: RuntimeBrowserClientPage,
  agent: boolean
): Promise<ClientHostedBrowserRpcRoute> {
  if (
    method === 'browser.goto' &&
    typeof requestParams.url === 'string' &&
    options.leases.clientPageInitializations.lease(page.browserPageId, page.placement) &&
    options.resolveExecutionHostKey &&
    options.notifyWorkspace
  ) {
    if (
      typeof requestParams.expectUrl === 'string' &&
      !isSameBrowserUrl(requestParams.expectUrl, page.url)
    ) {
      throw browserExpectedUrlMismatchError({
        expectedUrl: requestParams.expectUrl,
        actualUrl: page.url,
        browserPageId: page.browserPageId,
        mayHaveStarted: false
      })
    }
    const url = await actOnRuntimeBrowserInitialization({
      pages: options.pages,
      authority: options.leases,
      page,
      action: { type: 'navigate', url: requestParams.url },
      resolveExecutionHostKey: options.resolveExecutionHostKey,
      notifyWorkspace: options.notifyWorkspace
    })
    const current = options.pages.getPage(page.browserPageId)
    if (!current || !url) {
      throw new Error('browser_page_placement_stale')
    }
    return { handled: true, result: redactBrowserMetadata({ url, title: current.title }) }
  }
  if (method === 'browser.download') {
    const result = await downloadClientPageToPath(requestParams, page.browserPageId, (params) =>
      issueOnClientPage(options, method, params, page, agent).catch((error: unknown) => {
        // An older desktop's own wording blames the path it was never sent.
        throw error instanceof BrowserError &&
          error.code === 'browser_client_download_path_unsupported'
          ? browserClientPageRefusal(error.code)
          : error
      })
    )
    return { handled: true, result }
  }
  const releaseReads =
    method === 'browser.upload'
      ? grantClientPageUploadReads(page.browserPageId, absoluteUploadPaths(requestParams))
      : undefined
  try {
    return {
      handled: true,
      result: await issueOnClientPage(options, method, requestParams, page, agent)
    }
  } finally {
    releaseReads?.()
  }
}

async function issueOnClientPage(
  options: ClientAutomationRoute,
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>,
  page: RuntimeBrowserClientPage,
  agent: boolean
): Promise<unknown> {
  let issued: ReturnType<BrowserHostLeaseRegistry['issueClientPageCommand']>
  try {
    issued = options.leases.issueClientPageCommand(
      {
        authorityRuntimeId: options.leases.authorityRuntimeId,
        authorityEpoch: options.leases.authorityEpoch,
        browserPageId: page.browserPageId,
        browserHostClientId: page.placement.browserHostClientId,
        browserHostGeneration: page.placement.browserHostGeneration,
        pageHostGeneration: page.placement.pageHostGeneration
      },
      {
        type: 'automation',
        method,
        params,
        // A person's link or relayed input must not light the desktop page as agent-driven.
        agent,
        stagedResults: true
      }
    )
  } catch (error) {
    throw readableBrowserClientPageRefusal(error)
  }
  const result = await issued.result
  if (result.status === 'failed') {
    throw result.expectedUrlMismatch
      ? browserExpectedUrlMismatchError(result.expectedUrlMismatch)
      : browserClientNavigationFailure(method, params, result.errorCode, result.errorMessage)
  }
  return redactClientBrowserAutomationResult(method, result.value, params)
}

async function resolveTargetPage(
  params: Record<string, unknown>,
  pages: RuntimeBrowserPageRegistry,
  resolveWorkspace: (selector: string) => Promise<{ id: string }>
) {
  if (typeof params.page === 'string' && params.page.length > 0) {
    return pages.getPage(params.page)
  }
  if (typeof params.worktree !== 'string' || params.worktree.length === 0) {
    return undefined
  }
  const workspace = await resolveWorkspace(params.worktree)
  return pages.listPages(workspace.id).find((page) => page.active)
}

// Relative paths (older CLIs, paired callers) stay inside the workspace; absolute ones are this host's.
function absoluteUploadPaths(params: Record<string, unknown>): string[] {
  const files: unknown[] = Array.isArray(params.files) ? params.files : []
  return files.filter(
    (file): file is string =>
      typeof file === 'string' && (file.startsWith('/') || isWindowsAbsolutePathLike(file))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
