import { BrowserClientAutomationMethod } from '../../shared/browser-client-automation-protocol'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

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
      params: options.params
    }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
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
