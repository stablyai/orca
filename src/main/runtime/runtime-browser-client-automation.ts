import {
  BrowserClientAutomationMethod,
  type BrowserClientAutomationResult
} from '../../shared/browser-client-automation-protocol'
import { BrowserError } from '../browser/browser-error'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'

export type ClientHostedBrowserRpcRoute = { handled: false } | { handled: true; result: unknown }

export async function routeRuntimeBrowserClientAutomation(options: {
  method: string
  params: unknown
  pages: RuntimeBrowserPageRegistry
  leases: BrowserHostLeaseRegistry
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
        method: method.data,
        params: options.params
      }
    )
  } catch (error) {
    if (isBrowserHostUnavailableBeforeDispatch(error)) {
      throw browserHostUnavailableError(page)
    }
    if (isBrowserCommandOutcomeUnknown(error)) {
      throw browserCommandOutcomeUnknownError(page)
    }
    throw error
  }
  let result: BrowserClientAutomationResult
  try {
    result = await issued.result
  } catch (error) {
    if (isBrowserCommandOutcomeUnknown(error)) {
      throw browserCommandOutcomeUnknownError(page)
    }
    throw error
  }
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
  return { handled: true, result: result.value }
}

const BROWSER_HOST_UNAVAILABLE_BEFORE_DISPATCH = new Set([
  'browser_host_lease_reconnecting',
  'browser_host_lease_required',
  'browser_client_page_placement_required',
  'browser_host_command_delivery_required',
  'browser_host_command_ledger_closed',
  'browser_host_command_not_dispatched'
])

function isBrowserHostUnavailableBeforeDispatch(error: unknown): boolean {
  return error instanceof Error && BROWSER_HOST_UNAVAILABLE_BEFORE_DISPATCH.has(error.message)
}

function isBrowserCommandOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'browser_host_command_outcome_unknown' ||
      error.message === 'browser_host_command_delivery_failed')
  )
}

function browserHostUnavailableError(page: RuntimeBrowserClientPage): BrowserError {
  return new BrowserError(
    'browser_host_unavailable',
    'The desktop hosting this browser page is disconnected. Reconnect it and retry, or create a separate server-hosted page from the last known URL.',
    browserRecoveryData(page, true, [
      'Reconnect the desktop hosting this page, then retry the command.',
      'To continue independently, create a new page from lastKnownUrl with `orca tab create --url <url> --json`. The new page is server-hosted and does not preserve signed-in or transient page state.'
    ])
  )
}

function browserCommandOutcomeUnknownError(page: RuntimeBrowserClientPage): BrowserError {
  return new BrowserError(
    'browser_command_outcome_unknown',
    'The desktop disconnected after the browser command was dispatched, so it may have completed. Reconnect and inspect the page before retrying.',
    browserRecoveryData(page, false, [
      'Reconnect the desktop hosting this page.',
      'Inspect the page with `orca snapshot --page <page-id> --json` or `orca tab show --page <page-id> --json`.',
      'Retry only after confirming that the command did not take effect.'
    ])
  )
}

function browserRecoveryData(
  page: RuntimeBrowserClientPage,
  retryable: boolean,
  nextSteps: string[]
) {
  return {
    retryable,
    browserPageId: page.browserPageId,
    worktreeId: page.workspaceId,
    lastKnownUrl: page.url,
    nextSteps
  }
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
