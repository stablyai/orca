import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import { BrowserError } from '../browser/browser-error'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import type { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import {
  externalChromiumTabInfo,
  type ExternalChromiumPageRecord
} from './external-chromium-tab-projection'
const AgentBrowserCreatedTab = z.object({ tabId: z.string().min(1) })

export class ExternalChromiumTabRegistry {
  private readonly pagesByPublicId = new Map<string, ExternalChromiumPageRecord>()
  private readonly pagesByAgentId = new Map<string, ExternalChromiumPageRecord>()
  private readonly activePageIdByWorktree = new Map<string, string>()
  private initialAgentPageId: string | null = null

  constructor(private readonly session: ExternalChromiumBrowserSession) {}

  initialize(agentPageId: string): void {
    this.initialAgentPageId = agentPageId
  }

  clear(): void {
    this.pagesByPublicId.clear()
    this.pagesByAgentId.clear()
    this.activePageIdByWorktree.clear()
    this.initialAgentPageId = null
  }

  async createTab(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (typeof params.profileId === 'string' && params.profileId !== 'default') {
      throw new BrowserError(
        'browser_profile_unavailable',
        'Only the default browser profile is available.'
      )
    }
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const requestedPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    const existing = requestedPageId ? this.pagesByPublicId.get(requestedPageId) : undefined
    if (existing) {
      if (worktreeId && existing.worktreeId !== worktreeId) {
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${requestedPageId} was not found in this worktree.`
        )
      }
      this.setActivePage(existing)
      return { browserPageId: existing.publicPageId }
    }
    const url = normalizeBrowserNavigationUrl(String(params.url ?? 'about:blank'))
    if (!url) {
      throw new BrowserError(
        'invalid_argument',
        `Unsupported browser URL: ${String(params.url ?? '')}`
      )
    }
    let agentPageId: string
    if (this.initialAgentPageId) {
      agentPageId = this.initialAgentPageId
      this.initialAgentPageId = null
      await this.session.selectPage(agentPageId)
      await this.session.run(['open', url])
    } else {
      agentPageId = AgentBrowserCreatedTab.parse(await this.session.run(['tab', 'new', url])).tabId
    }
    const publicPageId = requestedPageId ?? randomUUID()
    const page = { agentPageId, publicPageId, worktreeId }
    this.pagesByPublicId.set(publicPageId, page)
    this.pagesByAgentId.set(agentPageId, page)
    this.setActivePage(page)
    host.markHeadlessBrowserSessionTabActive?.(worktreeId, publicPageId, {
      ...(typeof params.targetGroupId === 'string' ? { targetGroupId: params.targetGroupId } : {}),
      // Why true: an external-Chromium create has no paired-device caller to stay local for, so it
      // steers every screen exactly as this call did before create learned to stay local.
      focusesHost: true
    })
    if (worktreeId) {
      host.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
    }
    return { browserPageId: publicPageId }
  }

  async listTabs(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const requestedWorktreeId = await this.resolveWorktreeId(host, params.worktree)
    const tabs = await this.session.readTabs()
    const liveAgentPageIds = new Set(tabs.map((tab) => tab.tabId))
    for (const page of this.pagesByPublicId.values()) {
      if (!liveAgentPageIds.has(page.agentPageId)) {
        this.deletePage(page)
      }
    }
    const visibleTabs = tabs.flatMap((tab) => {
      const page = this.pagesByAgentId.get(tab.tabId)
      if (!page || (requestedWorktreeId && page.worktreeId !== requestedWorktreeId)) {
        return []
      }
      if (tab.active) {
        this.setActivePage(page)
      }
      return [{ page, tab }]
    })
    return {
      tabs: visibleTabs.map(({ page, tab }, index) => externalChromiumTabInfo(page, tab, index))
    }
  }

  async describeTab(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.describePage(await this.resolveTargetPage(host, params))
  }

  async currentTab(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const page = this.findActivePage(worktreeId)
    if (!page) {
      throw new BrowserError('browser_no_tab', 'No browser tab is active in this worktree.')
    }
    return this.describePage(page)
  }

  async switchTab(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const pages = [...this.pagesByPublicId.values()].filter(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : typeof params.index === 'number'
          ? pages[params.index]
          : undefined
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      throw new BrowserError('browser_tab_not_found', 'Browser tab was not found in this worktree.')
    }
    await this.session.selectPage(page.agentPageId)
    this.setActivePage(page)
    return { switched: pages.indexOf(page), browserPageId: page.publicPageId }
  }

  async closeTab(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const pages = [...this.pagesByPublicId.values()].filter(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : typeof params.index === 'number'
          ? pages[params.index]
          : this.findActivePage(worktreeId)
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      if (typeof params.page === 'string') {
        throw new BrowserError(
          'browser_tab_not_found',
          'Browser tab was not found in this worktree.'
        )
      }
      return { closed: false }
    }
    await this.session.run(['tab', 'close', page.agentPageId])
    this.deletePage(page)
    if (page.worktreeId) {
      host.notifyHeadlessBrowserSessionTabsChanged?.(page.worktreeId)
    }
    return { closed: true }
  }

  async resolveTargetPage(
    host: RuntimeBrowserCommandHost,
    params: Record<string, unknown>
  ): Promise<ExternalChromiumPageRecord> {
    const worktreeId = await this.resolveWorktreeId(host, params.worktree)
    const page =
      typeof params.page === 'string'
        ? this.pagesByPublicId.get(params.page)
        : this.findActivePage(worktreeId)
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      throw new BrowserError('browser_no_tab', 'No browser tab is active in this worktree.')
    }
    return page
  }

  async describePage(page: ExternalChromiumPageRecord): Promise<Record<string, unknown>> {
    const tabs = await this.session.readTabs()
    const scopedTabs = tabs.filter(
      (tab) => this.pagesByAgentId.get(tab.tabId)?.worktreeId === page.worktreeId
    )
    const index = scopedTabs.findIndex((tab) => tab.tabId === page.agentPageId)
    if (index === -1) {
      this.deletePage(page)
      throw new BrowserError('browser_tab_closed', 'Browser tab is no longer available.')
    }
    return externalChromiumTabInfo(page, scopedTabs[index], index)
  }

  private findActivePage(worktreeId?: string): ExternalChromiumPageRecord | undefined {
    const key = worktreeId ?? ''
    const activePageId = this.activePageIdByWorktree.get(key)
    const active = activePageId ? this.pagesByPublicId.get(activePageId) : undefined
    if (active) {
      return active
    }
    return [...this.pagesByPublicId.values()].find(
      (page) => !worktreeId || page.worktreeId === worktreeId
    )
  }

  private setActivePage(page: ExternalChromiumPageRecord): void {
    this.activePageIdByWorktree.set(page.worktreeId ?? '', page.publicPageId)
  }

  private deletePage(page: ExternalChromiumPageRecord): void {
    this.pagesByPublicId.delete(page.publicPageId)
    this.pagesByAgentId.delete(page.agentPageId)
    const key = page.worktreeId ?? ''
    if (this.activePageIdByWorktree.get(key) === page.publicPageId) {
      this.activePageIdByWorktree.delete(key)
    }
  }

  private async resolveWorktreeId(
    host: RuntimeBrowserCommandHost,
    worktree: unknown
  ): Promise<string | undefined> {
    return typeof worktree === 'string' && worktree
      ? (await host.resolveWorktreeSelector(worktree)).id
      : undefined
  }
}
