/**
 * The browser commands orcad answers itself. Pages a paired desktop hosts for it live in this
 * runtime's lease and page registries, so opening one never needs a browser engine here. Tab
 * commands see one logical list: the engine's tabs (if any), then the desktop-hosted pages.
 */
import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import type {
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../shared/runtime-types'
import { browserUnavailableError } from '../runtime/runtime-browser-commands-factory'
import { browserTabCreateClientPageStartsActive } from '../runtime/browser-tab-create-publication'
import {
  closeBrowserPageWithoutEngine,
  resolveClientPageToClose,
  retireRuntimeBrowserClientPage
} from '../runtime/browser/browser-client-page-close'
import {
  createBrowserClientPage,
  createBrowserPageOnPairedHost,
  DEFAULT_BROWSER_PROFILE_ID,
  hasPairedPageHost,
  openBrowserUrlOnClient
} from '../runtime/browser/browser-client-page-opening'
import {
  BrowserClientPageQueries,
  yieldClientPageSelection,
  type BrowserEngineTabs
} from '../runtime/browser/browser-client-page-queries'

/** Sends a call to the engine; `name` defaults to the member the proxy was asked for. */
type Forward = (args: unknown[], name?: string) => unknown

const LOGICAL_TAB_QUERIES = [
  'browserTabList',
  'browserTabCurrent',
  'browserTabShow',
  'browserTabSwitch'
] as const

/** The member orcad answers for `name`, or undefined to send it to the engine. */
export function orcadClientPageCommand(
  host: RuntimeBrowserCommandHost,
  name: string,
  forward: Forward,
  engineAvailable: () => boolean
): ((...args: never[]) => unknown) | undefined {
  const logicalTabs = (): BrowserClientPageQueries =>
    new BrowserClientPageQueries(
      host,
      orcadProfileLabel,
      engineAvailable() ? engineTabs(forward) : null
    )
  if (name === 'browserOpenUrlOnClient') {
    return (...args: Parameters<RuntimeBrowserCommands['browserOpenUrlOnClient']>) =>
      openBrowserUrlOnClient(host, args[0])
  }
  if (name === 'browserTabCreate') {
    return (...args: Parameters<RuntimeBrowserCommands['browserTabCreate']>) =>
      createTab(host, args, forward, engineAvailable)
  }
  if (name === 'browserTabClose') {
    return async (...args: Parameters<RuntimeBrowserCommands['browserTabClose']>) => {
      const params = args[0] ?? {}
      // Why the logical list: an index or the current tab may name a desktop-hosted page.
      const page = await resolveClientPageToClose(host, logicalTabs(), params)
      if (page) {
        return retireRuntimeBrowserClientPage(host, page)
      }
      return engineAvailable()
        ? forward(args)
        : closeBrowserPageWithoutEngine(host, params, browserUnavailableError)
    }
  }
  const query = LOGICAL_TAB_QUERIES.find((candidate) => candidate === name)
  if (query) {
    return (...args: unknown[]) => {
      const hasClientPages = host.getRuntimeBrowserPageRegistry().listPages().length > 0
      // Why: with nothing desktop-hosted, the engine's answer (or its refusal) is the whole answer.
      if (!hasClientPages && (engineAvailable() || !hasPairedPageHost(host))) {
        return forward(args)
      }
      return callTabQuery(logicalTabs(), query, args)
    }
  }
  return undefined
}

function createTab(
  host: RuntimeBrowserCommandHost,
  [params, caller]: Parameters<RuntimeBrowserCommands['browserTabCreate']>,
  forward: Forward,
  engineAvailable: () => boolean
): unknown {
  if (params?.placement?.kind === 'client') {
    const placement = params.placement
    return (async () => {
      const worktree = params.worktree
        ? await host.resolveBrowserWorkspace(params.worktree)
        : undefined
      return createBrowserClientPage(
        host,
        { ...params, placement },
        { worktree, browserProfileId: orcadBrowserProfileId(params.profileId), caller }
      )
    })()
  }
  // Why only for this host's own CLI: a paired client that left placement out asked for the server.
  if (
    !params?.placement &&
    !caller?.pairedDeviceId &&
    !engineAvailable() &&
    hasPairedPageHost(host)
  ) {
    return createBrowserPageOnPairedHost(
      host,
      params ?? {},
      orcadBrowserProfileId(params?.profileId)
    )
  }
  if (
    !engineAvailable() ||
    !browserTabCreateClientPageStartsActive(params?.activate) ||
    host.getRuntimeBrowserPageRegistry().listPages().length === 0
  ) {
    return forward([params, caller])
  }
  return (async () => {
    const created = await forward([params, caller])
    await yieldClientPageSelection(host, params?.worktree)
    return created
  })()
}

/** The engine's own tabs, read back through the proxy's forward. */
function engineTabs(forward: Forward): BrowserEngineTabs {
  return {
    list: async (params) =>
      requireTabResult(await forward([params], 'browserTabList'), isTabListResult),
    current: async (params) =>
      requireTabResult(await forward([params], 'browserTabCurrent'), isTabShowResult),
    switchTo: async (params) =>
      requireTabResult(await forward([params], 'browserTabSwitch'), isTabSwitchResult)
  }
}

function requireTabResult<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T {
  if (!guard(value)) {
    throw new BrowserError('browser_error', 'The browser engine returned an unreadable tab result.')
  }
  return value
}

function isTabListResult(value: unknown): value is BrowserTabListResult {
  return (
    isRecord(value) &&
    Array.isArray(value.tabs) &&
    value.tabs.every(
      (tab: unknown) =>
        isRecord(tab) && typeof tab.browserPageId === 'string' && typeof tab.active === 'boolean'
    )
  )
}

function isTabShowResult(value: unknown): value is BrowserTabShowResult {
  return isRecord(value) && isRecord(value.tab) && typeof value.tab.browserPageId === 'string'
}

function isTabSwitchResult(value: unknown): value is BrowserTabSwitchResult {
  return isRecord(value) && typeof value.browserPageId === 'string'
}

function callTabQuery(
  queries: BrowserClientPageQueries,
  name: (typeof LOGICAL_TAB_QUERIES)[number],
  args: unknown[]
): unknown {
  const params: Record<string, unknown> = isRecord(args[0]) ? args[0] : {}
  const worktree = typeof params.worktree === 'string' ? params.worktree : undefined
  const page = typeof params.page === 'string' ? params.page : undefined
  switch (name) {
    case 'browserTabList':
      return queries.browserTabList({ worktree })
    case 'browserTabCurrent':
      return queries.browserTabCurrent({ worktree })
    case 'browserTabShow':
      if (!page) {
        throw new BrowserError('invalid_argument', 'Missing required --page')
      }
      return queries.browserTabShow({ page, worktree })
    case 'browserTabSwitch':
      return queries.browserTabSwitch({
        worktree,
        page,
        index: typeof params.index === 'number' ? params.index : undefined,
        focus: typeof params.focus === 'boolean' ? params.focus : undefined
      })
  }
}

// Why only the default: orcad has no profile registry to describe any other to a desktop.
function orcadBrowserProfileId(profileId: string | undefined): string {
  if (profileId !== undefined && profileId !== DEFAULT_BROWSER_PROFILE_ID) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return DEFAULT_BROWSER_PROFILE_ID
}

function orcadProfileLabel(browserProfileId: string): { id: string; label: string } {
  return {
    id: browserProfileId,
    label: browserProfileId === DEFAULT_BROWSER_PROFILE_ID ? 'Default' : browserProfileId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
