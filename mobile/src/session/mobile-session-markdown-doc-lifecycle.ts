import type {
  MarkdownDocState,
  MobileSessionTab
} from '../../app/h/[hostId]/session/mobile-session-route-types'

type MobileMarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>

type MobileMarkdownDocUpdater = (
  update: (current: Map<string, MarkdownDocState>) => Map<string, MarkdownDocState>
) => void

type MobileMarkdownDocLoadToken = {
  generation: number
  requestId: number
  tabId: string
  tabIdentity: string
}

export class MobileSessionMarkdownDocLifecycle {
  private generation = 0
  private nextRequestId = 0
  private readonly liveTabIdentityById = new Map<string, string>()
  private readonly activeRequestIdByTabId = new Map<string, number>()

  reconcile(tabs: readonly MobileSessionTab[], updateDocs: MobileMarkdownDocUpdater): void {
    const nextIdentityById = new Map(
      tabs
        .filter((tab): tab is MobileMarkdownTab => tab.type === 'markdown')
        .map((tab) => [tab.id, markdownTabIdentity(tab)])
    )
    const replacedTabIds = new Set<string>()
    for (const [tabId, currentIdentity] of this.liveTabIdentityById) {
      const nextIdentity = nextIdentityById.get(tabId)
      if (nextIdentity && nextIdentity !== currentIdentity) {
        replacedTabIds.add(tabId)
      }
    }
    for (const tabId of this.activeRequestIdByTabId.keys()) {
      if (nextIdentityById.get(tabId) !== this.liveTabIdentityById.get(tabId)) {
        this.activeRequestIdByTabId.delete(tabId)
      }
    }
    this.liveTabIdentityById.clear()
    for (const [tabId, identity] of nextIdentityById) {
      this.liveTabIdentityById.set(tabId, identity)
    }
    updateDocs((current) => retainLiveMarkdownDocs(current, nextIdentityById, replacedTabIds))
  }

  async load(
    tab: MobileMarkdownTab,
    updateDocs: MobileMarkdownDocUpdater,
    read: () => Promise<Extract<MarkdownDocState, { status: 'ready' }>>
  ): Promise<void> {
    const token = this.beginLoad(tab)
    if (!token) {
      return
    }
    updateDocs((current) => new Map(current).set(tab.id, { status: 'loading' }))
    try {
      const doc = await read()
      if (this.finishLoad(token)) {
        updateDocs((current) => new Map(current).set(tab.id, doc))
      }
    } catch {
      if (this.finishLoad(token)) {
        updateDocs((current) =>
          new Map(current).set(tab.id, {
            status: 'error',
            message: "Couldn't load markdown"
          })
        )
      }
    }
  }

  close(tabId: string, updateDocs: MobileMarkdownDocUpdater): void {
    this.liveTabIdentityById.delete(tabId)
    this.activeRequestIdByTabId.delete(tabId)
    updateDocs((current) => removeMarkdownDoc(current, tabId))
  }

  reset(): void {
    this.generation += 1
    this.liveTabIdentityById.clear()
    this.activeRequestIdByTabId.clear()
  }

  private beginLoad(tab: MobileMarkdownTab): MobileMarkdownDocLoadToken | null {
    const tabIdentity = markdownTabIdentity(tab)
    if (this.liveTabIdentityById.get(tab.id) !== tabIdentity) {
      return null
    }
    const requestId = ++this.nextRequestId
    this.activeRequestIdByTabId.set(tab.id, requestId)
    return {
      generation: this.generation,
      requestId,
      tabId: tab.id,
      tabIdentity
    }
  }

  private finishLoad(token: MobileMarkdownDocLoadToken): boolean {
    if (
      token.generation !== this.generation ||
      this.liveTabIdentityById.get(token.tabId) !== token.tabIdentity ||
      this.activeRequestIdByTabId.get(token.tabId) !== token.requestId
    ) {
      return false
    }
    this.activeRequestIdByTabId.delete(token.tabId)
    return true
  }
}

function retainLiveMarkdownDocs(
  docs: Map<string, MarkdownDocState>,
  liveIdentityById: ReadonlyMap<string, string>,
  replacedTabIds: ReadonlySet<string>
): Map<string, MarkdownDocState> {
  let next: Map<string, MarkdownDocState> | null = null
  for (const tabId of docs.keys()) {
    if (liveIdentityById.has(tabId) && !replacedTabIds.has(tabId)) {
      continue
    }
    next ??= new Map(docs)
    next.delete(tabId)
  }
  return next ?? docs
}

function removeMarkdownDoc(
  docs: Map<string, MarkdownDocState>,
  tabId: string
): Map<string, MarkdownDocState> {
  if (!docs.has(tabId)) {
    return docs
  }
  const next = new Map(docs)
  next.delete(tabId)
  return next
}

function markdownTabIdentity(tab: MobileMarkdownTab): string {
  return JSON.stringify([tab.id, tab.filePath, tab.relativePath])
}
