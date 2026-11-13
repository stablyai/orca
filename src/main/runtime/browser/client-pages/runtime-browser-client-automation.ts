import { actOnRuntimeBrowserInitialization } from './runtime-browser-page-initialization-action'
import { isSameBrowserUrl } from '../../../../shared/browser/client-hosting/browser-expected-url'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserError } from '../../../browser/browser-error'
import { browserExpectedUrlMismatchError } from '../../../browser/cdp/input/browser-expected-page-url'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { isAgentRpcCaller, type RpcCallerIdentity } from '../../rpc/callers/rpc-caller-identity'

export type ClientHostedBrowserRpcRoute = { handled: false } | { handled: true; result: unknown }

export async function routeRuntimeBrowserClientAutomation(options: {
  method: string
  params: unknown
  caller: RpcCallerIdentity | undefined
  pages: RuntimeBrowserPageRegistry
  leases: BrowserHostLeaseRegistry
  resolveExecutionHostKey?(workspaceId: string): Promise<BrowserExecutionHostKeyResolution>
  notifyWorkspace?(workspaceId: string): void
  resolveWorkspace(selector: string): Promise<{ id: string }>
}): Promise<ClientHostedBrowserRpcRoute> {
  const method = BrowserClientAutomationMethod.safeParse(options.method)
  if (!method.success || !isRecord(options.params)) {
    return { handled: false }
  }
  const page = await resolveTargetPage(options.params, options.pages, options.resolveWorkspace)
  if (!page) {
    return { handled: false }
  }
  if (
    method.data === 'browser.goto' &&
    typeof options.params.url === 'string' &&
    options.leases.clientPageInitializations.lease(page.browserPageId, page.placement) &&
    options.resolveExecutionHostKey &&
    options.notifyWorkspace
  ) {
    if (
      typeof options.params.expectUrl === 'string' &&
      !isSameBrowserUrl(options.params.expectUrl, page.url)
    ) {
      throw browserExpectedUrlMismatchError({
        expectedUrl: options.params.expectUrl,
        actualUrl: page.url,
        browserPageId: page.browserPageId,
        mayHaveStarted: false
      })
    }
    const url = await actOnRuntimeBrowserInitialization({
      pages: options.pages,
      authority: options.leases,
      page,
      action: { type: 'navigate', url: options.params.url },
      resolveExecutionHostKey: options.resolveExecutionHostKey,
      notifyWorkspace: options.notifyWorkspace
    })
    const current = options.pages.getPage(page.browserPageId)
    if (!current || !url) {
      throw new Error('browser_page_placement_stale')
    }
    return { handled: true, result: { url, title: current.title } }
  }
  const issued = options.leases.issueClientPageCommand(
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
      method: method.data,
      params: options.params,
      // A person's link or relayed input must not light the desktop page as agent-driven.
      agent: isAgentRpcCaller(options.caller),
      stagedResults: true
    }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw result.expectedUrlMismatch
      ? browserExpectedUrlMismatchError(result.expectedUrlMismatch)
      : new BrowserError(result.errorCode, result.errorMessage ?? result.errorCode)
  }
  return { handled: true, result: result.value }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
