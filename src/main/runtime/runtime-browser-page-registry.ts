import {
  sameRuntimeBrowserPlacement,
  type RuntimeBrowserClientPlacement
} from '../../shared/runtime-browser-placement'

const DEFAULT_MAX_RUNTIME_BROWSER_PAGES = 256
const MAX_IDENTITY_LENGTH = 256

export type RuntimeBrowserClientPage = Readonly<{
  browserPageId: string
  workspaceId: string
  browserProfileId: string
  executionHostKey: string
  placement: RuntimeBrowserClientPlacement
  /**
   * The paired device that asked for this page. Survives the lease, which the placement does not:
   * a retained page has no lease left to look its host's name up through.
   */
  pairedDeviceId?: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  metadataRevision: number
}>

type RuntimeBrowserClientPageInput = Pick<
  RuntimeBrowserClientPage,
  | 'browserPageId'
  | 'workspaceId'
  | 'browserProfileId'
  | 'executionHostKey'
  | 'placement'
  | 'url'
  | 'loading'
  | 'active'
> &
  Partial<
    Pick<
      RuntimeBrowserClientPage,
      'pairedDeviceId' | 'title' | 'canGoBack' | 'canGoForward' | 'metadataRevision'
    >
  >

type RuntimeBrowserPageUpdate = Partial<
  Pick<RuntimeBrowserClientPage, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'>
>

type RuntimeBrowserPageMetadata = Pick<
  RuntimeBrowserClientPage,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'metadataRevision'
>

export class RuntimeBrowserPageRegistry {
  private readonly pages = new Map<string, RuntimeBrowserClientPage>()
  private globalActivePageId: string | null = null
  private readonly maxPages: number

  constructor(options: { maxPages?: number } = {}) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_RUNTIME_BROWSER_PAGES
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1) {
      throw new Error('browser_runtime_page_limit_invalid')
    }
  }

  publishClientPage(input: RuntimeBrowserClientPageInput): RuntimeBrowserClientPage {
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
    if (input.active) {
      this.deactivateWorkspace(input.workspaceId)
    }
    const page = freezePage({
      ...input,
      placement: Object.freeze({ ...input.placement }),
      title: input.title ?? 'Browser',
      canGoBack: input.canGoBack ?? false,
      canGoForward: input.canGoForward ?? false,
      metadataRevision: input.metadataRevision ?? 0
    })
    this.pages.set(page.browserPageId, page)
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
    const next = freezePage({ ...current, ...update, placement: current.placement })
    this.pages.set(browserPageId, next)
    return next
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
    this.pages.set(
      browserPageId,
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
    placement: RuntimeBrowserClientPlacement
  ): RuntimeBrowserClientPage {
    const current = this.requireExactPage(browserPageId, placement)
    this.deactivateWorkspace(current.workspaceId)
    const next = freezePage({ ...current, active: true, placement: current.placement })
    this.pages.set(browserPageId, next)
    this.globalActivePageId = browserPageId
    return next
  }

  retirePage(browserPageId: string, placement: RuntimeBrowserClientPlacement): boolean {
    const current = this.pages.get(browserPageId)
    if (!current || !sameRuntimeBrowserPlacement(current.placement, placement)) {
      return false
    }
    this.pages.delete(browserPageId)
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
    executionHostKey?: string
  ): RuntimeBrowserClientPage {
    const current = this.requireExactPage(browserPageId, expected)
    if (executionHostKey !== undefined) {
      assertIdentity(executionHostKey)
    }
    // Why the revision restarts: it is the replacing host's own counter, and a host that just took
    // this placement over counts from zero. Keeping the old high-water mark deafens the page to
    // that host until it catches up.
    const next = freezePage({
      ...current,
      ...(executionHostKey === undefined ? {} : { executionHostKey }),
      metadataRevision: 0,
      placement: Object.freeze({ ...placement })
    })
    this.pages.set(browserPageId, next)
    return next
  }

  getPage(browserPageId: string): RuntimeBrowserClientPage | undefined {
    return this.pages.get(browserPageId)
  }

  listPages(workspaceId?: string): readonly RuntimeBrowserClientPage[] {
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

const registries = new WeakMap<object, RuntimeBrowserPageRegistry>()

export function getRuntimeBrowserPageRegistry(runtime: object): RuntimeBrowserPageRegistry {
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
