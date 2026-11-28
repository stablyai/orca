import {
  sameRuntimeBrowserPlacement,
  type RuntimeBrowserClientPlacement
} from '../../../../shared/browser/client-hosting/runtime-browser-placement'
import type { TeammateTabListKey } from '../../../bots/team-share/teammate-rules'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserClientPageInput,
  RuntimeBrowserPageMetadata,
  RuntimeBrowserPageUpdate
} from './runtime-browser-client-page'
import {
  AgentPageUse,
  personPickWaits,
  type BrowserPagePicker
} from '../../../browser/agent-browser/session-routing/person-pick-hold'

const DEFAULT_MAX_RUNTIME_BROWSER_PAGES = 256
const MAX_IDENTITY_LENGTH = 256

export type { RuntimeBrowserClientPage } from './runtime-browser-client-page'

/** Whose tab list a page is in: the host's, or the teammate's own list that opened it. */
export type PageList = 'host' | TeammateTabListKey

export function pageListOf(page: Pick<RuntimeBrowserClientPage, 'holder'>): PageList {
  return page.holder ?? 'host'
}

export class RuntimeBrowserPageRegistry {
  private readonly pages = new Map<string, RuntimeBrowserClientPage>()
  private globalActivePageId: string | null = null
  // A person's pick per workspace, waiting for the agent's page to go idle.
  private readonly heldPersonPicks = new Map<string, string>()
  /** Agent commands on client pages; a person's pick waits while the routed page is in use. */
  readonly agentUse = new AgentPageUse()
  private readonly maxPages: number
  private onRetired?: (page: RuntimeBrowserClientPage) => void
  private holderOf: (browserPageId: string) => TeammateTabListKey | null = () => null
  private onHeldPageChanged?: (page: RuntimeBrowserClientPage) => void

  constructor(options: { maxPages?: number } = {}) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_RUNTIME_BROWSER_PAGES
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1) {
      throw new Error('browser_runtime_page_limit_invalid')
    }
  }

  setRetirementListener(listener: (page: RuntimeBrowserClientPage) => void): void {
    this.onRetired = listener
  }

  /** Who holds a page as it is published (a teammate's own list that opened it, or none), and who
   *  redraws when a held page changes. */
  setHolders(
    holderOf: (browserPageId: string) => TeammateTabListKey | null,
    onHeldPageChanged: (page: RuntimeBrowserClientPage) => void
  ): void {
    this.holderOf = holderOf
    this.onHeldPageChanged = onHeldPageChanged
  }

  /** Every page record write passes here. */
  private store(page: RuntimeBrowserClientPage): RuntimeBrowserClientPage {
    this.pages.set(page.browserPageId, page)
    if (page.holder) {
      this.onHeldPageChanged?.(page)
    }
    return page
  }

  /** Omitting the picker publishes as asked, as restores and adoptions do. */
  publishClientPage(
    input: RuntimeBrowserClientPageInput,
    picker?: BrowserPagePicker
  ): RuntimeBrowserClientPage {
    assertIdentity(input.browserPageId)
    assertIdentity(input.workspaceId)
    assertIdentity(input.browserProfileId)
    assertIdentity(input.executionHostKey)
    if (this.pages.has(input.browserPageId)) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
    if (this.pages.size >= this.maxPages) {
      throw new Error('browser_runtime_page_capacity')
    }
    const holder = this.holderOf(input.browserPageId)
    const held =
      input.active &&
      !holder &&
      picker === 'person' &&
      this.personPickWaitsIn(input.workspaceId, input.browserPageId)
    const active = input.active && !held && !holder
    if (active) {
      this.deactivateWorkspace(input.workspaceId)
    }
    const page = freezePage({
      ...input,
      ...(holder ? { holder } : {}),
      active,
      placement: Object.freeze({ ...input.placement }),
      title: input.title ?? 'Browser',
      canGoBack: input.canGoBack ?? false,
      canGoForward: input.canGoForward ?? false,
      metadataRevision: input.metadataRevision ?? 0
    })
    this.store(page)
    if (held) {
      this.heldPersonPicks.set(page.workspaceId, page.browserPageId)
    } else if (active && picker !== undefined) {
      this.picked(page, picker)
    }
    if (page.active) {
      this.globalActivePageId = page.browserPageId
    }
    return page
  }

  updatePage(
    browserPageId: string,
    placement: RuntimeBrowserClientPlacement,
    update: RuntimeBrowserPageUpdate
  ): RuntimeBrowserClientPage {
    const current = this.requireExactPage(browserPageId, placement)
    return this.store(freezePage({ ...current, ...update, placement: current.placement }))
  }

  updatePageMetadata(
    browserPageId: string,
    placement: RuntimeBrowserClientPlacement,
    update: Omit<RuntimeBrowserPageMetadata, 'metadataRevision'> & { revision: number }
  ): boolean {
    const current = this.requireExactPage(browserPageId, placement)
    if (!Number.isSafeInteger(update.revision) || update.revision < 1) {
      throw new Error('browser_page_metadata_revision_invalid')
    }
    if (update.revision <= current.metadataRevision) {
      return false
    }
    const { revision, ...metadata } = update
    this.store(
      freezePage({
        ...current,
        ...metadata,
        metadataRevision: revision,
        placement: current.placement
      })
    )
    return true
  }

  activatePage(
    browserPageId: string,
    placement: RuntimeBrowserClientPlacement,
    picker: BrowserPagePicker
  ): RuntimeBrowserClientPage {
    const current = this.requireExactPage(browserPageId, placement)
    if (current.holder) {
      return current
    }
    if (picker === 'person' && this.personPickWaitsIn(current.workspaceId, browserPageId)) {
      this.heldPersonPicks.set(current.workspaceId, browserPageId)
      return current
    }
    const next = this.select(current)
    this.picked(next, picker)
    return next
  }

  private picked(page: RuntimeBrowserClientPage, picker: BrowserPagePicker): void {
    // A newer pick than the held one, by the agent or the person.
    this.heldPersonPicks.delete(page.workspaceId)
    if (picker === 'agent') {
      // Mark the new page now, or a person's pick before the agent's next command would take it.
      this.agentUse.begin(page.browserPageId)()
    }
  }

  private select(page: RuntimeBrowserClientPage, takesGlobal = true): RuntimeBrowserClientPage {
    this.deactivateWorkspace(page.workspaceId)
    const next = freezePage({ ...page, active: true, placement: page.placement })
    this.pages.set(page.browserPageId, next)
    this.globalActivePageId = takesGlobal ? page.browserPageId : this.globalActivePageId
    return next
  }

  private personPickWaitsIn(workspaceId: string, pickedPageId: string): boolean {
    const routed = [...this.pages.values()].find(
      (page) => page.workspaceId === workspaceId && page.active
    )
    return personPickWaits(routed?.browserPageId ?? null, pickedPageId, this.agentUse.isUsing)
  }

  private applyHeldPersonPicks(workspaceId?: string): void {
    for (const [heldWorkspaceId, browserPageId] of this.heldPersonPicks) {
      if (
        (workspaceId === undefined || heldWorkspaceId === workspaceId) &&
        !this.personPickWaitsIn(heldWorkspaceId, browserPageId)
      ) {
        this.heldPersonPicks.delete(heldWorkspaceId)
        const page = this.pages.get(browserPageId)
        const global = this.globalActivePageId ? this.pages.get(this.globalActivePageId) : undefined
        if (page) {
          // A late pick takes the global selection only while nothing newer has moved it elsewhere.
          this.select(page, global?.workspaceId === heldWorkspaceId)
        }
      }
    }
  }

  retirePage(browserPageId: string, placement: RuntimeBrowserClientPlacement): boolean {
    const current = this.pages.get(browserPageId)
    if (!current || !sameRuntimeBrowserPlacement(current.placement, placement)) {
      return false
    }
    this.pages.delete(browserPageId)
    this.agentUse.forget(browserPageId)
    if (this.heldPersonPicks.get(current.workspaceId) === browserPageId) {
      this.heldPersonPicks.delete(current.workspaceId)
    }
    this.onRetired?.(current)
    if (this.globalActivePageId === browserPageId) {
      this.globalActivePageId = null
    }
    return true
  }

  replaceClientPagePlacement(
    browserPageId: string,
    expected: RuntimeBrowserClientPlacement,
    placement: RuntimeBrowserClientPlacement,
    /** The route key the replacing host was actually placed under; keys do not survive a restart. */
    executionHostKey?: string,
    browserProfileId?: string
  ): RuntimeBrowserClientPage {
    const current = this.requireExactPage(browserPageId, expected)
    if (executionHostKey !== undefined) {
      assertIdentity(executionHostKey)
    }
    if (browserProfileId !== undefined) {
      assertIdentity(browserProfileId)
    }
    // Replacement hosts count revisions from zero; old high-water would suppress their first publishes.
    const next = freezePage({
      ...current,
      ...(executionHostKey === undefined ? {} : { executionHostKey }),
      ...(browserProfileId === undefined ? {} : { browserProfileId }),
      metadataRevision: 0,
      placement: Object.freeze({ ...placement })
    })
    return this.store(next)
  }

  getPage(browserPageId: string): RuntimeBrowserClientPage | undefined {
    return this.pages.get(browserPageId)
  }

  /** Whether a change to this page (or an engine tab, which has no record) is the host list's to
   *  announce. A held page's own list redraws as its record is stored, never the host's. */
  notifiesHostList(browserPageId: string | undefined): boolean {
    return !(browserPageId && this.pages.get(browserPageId)?.holder)
  }

  /** The pages one list holds: the host's are those no teammate's own list holds. The only way to
   *  list pages for a caller or act on them by index. */
  pagesOf(list: PageList, workspaceId?: string): readonly RuntimeBrowserClientPage[] {
    return this.everyPage(workspaceId).filter((page) => pageListOf(page) === list)
  }

  /** Every page record, whoever's list holds it: only for keeping the records themselves
   *  (persistence, retirement, a desktop's reconnect inventory), never to list or act for a caller. */
  everyPage(workspaceId?: string): readonly RuntimeBrowserClientPage[] {
    this.applyHeldPersonPicks(workspaceId)
    const pages = [...this.pages.values()]
    if (workspaceId !== undefined) {
      return pages.filter((page) => page.workspaceId === workspaceId)
    }
    return pages.map((page) => {
      const active = page.browserPageId === this.globalActivePageId
      return page.active === active
        ? page
        : freezePage({ ...page, active, placement: page.placement })
    })
  }

  deactivateGlobal(): void {
    this.globalActivePageId = null
  }

  /** An engine tab took the selection; unscoped creates and switches move only the global pick. */
  yieldSelection(workspaceId: string | undefined): void {
    this.deactivateGlobal()
    if (workspaceId !== undefined) {
      // A newer pick than the held one, by the agent or the person.
      this.heldPersonPicks.delete(workspaceId)
      this.deactivateWorkspace(workspaceId)
    }
  }

  deactivateWorkspace(workspaceId: string): void {
    for (const [browserPageId, page] of this.pages) {
      if (page.workspaceId === workspaceId && page.active) {
        this.pages.set(
          browserPageId,
          freezePage({ ...page, active: false, placement: page.placement })
        )
      }
    }
    const globalPage = this.globalActivePageId ? this.pages.get(this.globalActivePageId) : undefined
    if (globalPage?.workspaceId === workspaceId) {
      this.globalActivePageId = null
    }
  }

  private requireExactPage(
    browserPageId: string,
    placement: RuntimeBrowserClientPlacement
  ): RuntimeBrowserClientPage {
    const page = this.pages.get(browserPageId)
    if (!page || !sameRuntimeBrowserPlacement(page.placement, placement)) {
      throw new Error('browser_page_placement_stale')
    }
    return page
  }
}

/** Key by runtime object identity only; host types need no common member and this module reads no runtime state. */
const registries = new WeakMap<WeakKey, RuntimeBrowserPageRegistry>()

export function getRuntimeBrowserPageRegistry(runtime: WeakKey): RuntimeBrowserPageRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new RuntimeBrowserPageRegistry()
    registries.set(runtime, registry)
  }
  return registry
}

function freezePage(page: RuntimeBrowserClientPage): RuntimeBrowserClientPage {
  return Object.freeze(page)
}

function assertIdentity(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTITY_LENGTH) {
    throw new Error('browser_runtime_page_identity_invalid')
  }
}
