import type { MobileFileTabDoc } from '../files/mobile-file-tab-doc'

export type MobileFileTabIdentity = {
  id: string
  filePath: string
  relativePath: string
  mode?: 'edit' | 'diff'
  diffSource?: 'staged' | 'unstaged' | 'branch' | 'commit'
}

export type MobileFileDocLoadToken = {
  generation: number
  requestId: number
  tabId: string
  tabIdentity: string
}

export type MobileFileDocLifecycle = {
  generation: number
  nextRequestId: number
  liveTabIdentityById: Map<string, string>
  activeRequestIdByTabId: Map<string, number>
}

type MobileFileTabCandidate = {
  type: string
  id: string
  filePath?: unknown
  relativePath?: unknown
  mode?: unknown
  diffSource?: unknown
}

type MobileSessionFileDoc =
  | MobileFileTabDoc
  | { status: 'loading' }
  | { status: 'error'; message: string }

type MobileSessionFileDocUpdater = (
  update: (current: Map<string, MobileSessionFileDoc>) => Map<string, MobileSessionFileDoc>
) => void

export class MobileSessionFileDocLifecycle {
  private readonly lifecycle = createMobileFileDocLifecycle()

  reconcile(
    tabs: readonly MobileFileTabCandidate[],
    updateDocs: MobileSessionFileDocUpdater
  ): void {
    const replacedTabIds = reconcileMobileFileDocTabs(
      this.lifecycle,
      tabs.filter(isMobileFileTabIdentity)
    )
    updateDocs((current) => retainLiveMobileFileDocs(current, this.lifecycle, replacedTabIds))
  }

  async load(
    tab: MobileFileTabIdentity,
    updateDocs: MobileSessionFileDocUpdater,
    read: () => Promise<MobileFileTabDoc>
  ): Promise<void> {
    const token = beginMobileFileDocLoad(this.lifecycle, tab)
    if (!token) {
      return
    }
    updateDocs((current) => new Map(current).set(tab.id, { status: 'loading' }))
    try {
      const doc = await read()
      if (finishMobileFileDocLoad(this.lifecycle, token)) {
        updateDocs((current) => new Map(current).set(tab.id, doc))
      }
    } catch (error) {
      if (finishMobileFileDocLoad(this.lifecycle, token)) {
        updateDocs((current) =>
          new Map(current).set(tab.id, {
            status: 'error',
            message: getMobileFileDocLoadErrorMessage(tab, error)
          })
        )
      }
    }
  }

  close(tabId: string, updateDocs: MobileSessionFileDocUpdater): void {
    forgetMobileFileDocTab(this.lifecycle, tabId)
    updateDocs((current) => removeMobileFileDoc(current, tabId))
  }

  reset(): void {
    resetMobileFileDocLifecycle(this.lifecycle)
  }
}

export function createMobileFileDocLifecycle(): MobileFileDocLifecycle {
  return {
    generation: 0,
    nextRequestId: 0,
    liveTabIdentityById: new Map(),
    activeRequestIdByTabId: new Map()
  }
}

export function reconcileMobileFileDocTabs(
  lifecycle: MobileFileDocLifecycle,
  tabs: readonly MobileFileTabIdentity[]
): ReadonlySet<string> {
  const nextIdentityById = new Map(tabs.map((tab) => [tab.id, getMobileFileTabIdentity(tab)]))
  const replacedTabIds = new Set<string>()
  for (const tabId of lifecycle.activeRequestIdByTabId.keys()) {
    const nextIdentity = nextIdentityById.get(tabId)
    const currentIdentity = lifecycle.liveTabIdentityById.get(tabId)
    if (!nextIdentity || nextIdentity !== currentIdentity) {
      lifecycle.activeRequestIdByTabId.delete(tabId)
    }
  }
  for (const [tabId, currentIdentity] of lifecycle.liveTabIdentityById) {
    const nextIdentity = nextIdentityById.get(tabId)
    if (nextIdentity && nextIdentity !== currentIdentity) {
      replacedTabIds.add(tabId)
    }
  }
  lifecycle.liveTabIdentityById.clear()
  for (const [tabId, identity] of nextIdentityById) {
    lifecycle.liveTabIdentityById.set(tabId, identity)
  }
  return replacedTabIds
}

export function beginMobileFileDocLoad(
  lifecycle: MobileFileDocLifecycle,
  tab: MobileFileTabIdentity
): MobileFileDocLoadToken | null {
  const tabIdentity = getMobileFileTabIdentity(tab)
  if (lifecycle.liveTabIdentityById.get(tab.id) !== tabIdentity) {
    return null
  }
  const requestId = ++lifecycle.nextRequestId
  lifecycle.activeRequestIdByTabId.set(tab.id, requestId)
  return {
    generation: lifecycle.generation,
    requestId,
    tabId: tab.id,
    tabIdentity
  }
}

export function finishMobileFileDocLoad(
  lifecycle: MobileFileDocLifecycle,
  token: MobileFileDocLoadToken
): boolean {
  if (!isCurrentMobileFileDocLoad(lifecycle, token)) {
    return false
  }
  lifecycle.activeRequestIdByTabId.delete(token.tabId)
  return true
}

export function forgetMobileFileDocTab(lifecycle: MobileFileDocLifecycle, tabId: string): void {
  lifecycle.liveTabIdentityById.delete(tabId)
  lifecycle.activeRequestIdByTabId.delete(tabId)
}

export function resetMobileFileDocLifecycle(lifecycle: MobileFileDocLifecycle): void {
  lifecycle.generation += 1
  lifecycle.liveTabIdentityById.clear()
  lifecycle.activeRequestIdByTabId.clear()
}

export function retainLiveMobileFileDocs<T>(
  docs: Map<string, T>,
  lifecycle: MobileFileDocLifecycle,
  replacedTabIds?: ReadonlySet<string>
): Map<string, T> {
  let next: Map<string, T> | null = null
  for (const tabId of docs.keys()) {
    if (lifecycle.liveTabIdentityById.has(tabId) && !replacedTabIds?.has(tabId)) {
      continue
    }
    next ??= new Map(docs)
    next.delete(tabId)
  }
  return next ?? docs
}

export function removeMobileFileDoc<T>(docs: Map<string, T>, tabId: string): Map<string, T> {
  if (!docs.has(tabId)) {
    return docs
  }
  const next = new Map(docs)
  next.delete(tabId)
  return next
}

function isCurrentMobileFileDocLoad(
  lifecycle: MobileFileDocLifecycle,
  token: MobileFileDocLoadToken
): boolean {
  return (
    lifecycle.generation === token.generation &&
    lifecycle.liveTabIdentityById.get(token.tabId) === token.tabIdentity &&
    lifecycle.activeRequestIdByTabId.get(token.tabId) === token.requestId
  )
}

function getMobileFileTabIdentity(tab: MobileFileTabIdentity): string {
  return JSON.stringify([
    tab.id,
    tab.filePath,
    tab.relativePath,
    tab.mode ?? '',
    tab.diffSource ?? ''
  ])
}

function isMobileFileTabIdentity(
  tab: MobileFileTabCandidate
): tab is MobileFileTabCandidate & MobileFileTabIdentity {
  return (
    tab.type === 'file' &&
    typeof tab.filePath === 'string' &&
    typeof tab.relativePath === 'string' &&
    (tab.mode === undefined || tab.mode === 'edit' || tab.mode === 'diff') &&
    (tab.diffSource === undefined ||
      tab.diffSource === 'staged' ||
      tab.diffSource === 'unstaged' ||
      tab.diffSource === 'branch' ||
      tab.diffSource === 'commit')
  )
}

function getMobileFileDocLoadErrorMessage(tab: MobileFileTabIdentity, error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'binary_file') {
    return 'Binary preview unavailable'
  }
  if (message === 'file_too_large') {
    return 'File too large for mobile preview'
  }
  return tab.diffSource === 'staged' || tab.diffSource === 'unstaged'
    ? "Couldn't load diff preview"
    : "Couldn't load file preview"
}
