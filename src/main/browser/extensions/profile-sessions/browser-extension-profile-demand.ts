import { getBrowserSessionProfileIdentity } from '../../sessions/profiles/browser-session-profile-identity'
import { isBrowserExtensionSupportEnabled } from '../browser-extension-support'

type Owner = {
  readonly ready: Promise<void>
  release: () => Promise<void>
  changed: Set<() => void>
}
type ProfileDemand = {
  pages: Set<object>
  targets: Map<string, Set<object>>
  active: Map<string, { ready: Promise<void>; failed: boolean }>
  ready: Promise<void>
  changed: Set<() => void>
  enabled: () => string[]
  activate: (extensionId: string, page: boolean) => Promise<void>
  suspend: (extensionId: string) => Promise<void>
  activating?: (ready: Promise<void>) => void
}
const profiles = new Map<string, ProfileDemand>()
const pageObservers = new Set<(profileId: string) => void>()
type Page = { owner: Owner; ready: Promise<void>; changed: Set<() => void>; detach: () => void }
const pages = new Map<Electron.WebContents, Page>()
const noDemand = (): Owner => ({
  ready: Promise.resolve(),
  release: () => Promise.resolve(),
  changed: new Set()
})

export function attachBrowserExtensionProfileDemand(
  profileId: string,
  activate: ProfileDemand['activate'],
  suspend: ProfileDemand['suspend'],
  enabled: () => string[],
  activating?: ProfileDemand['activating']
): void {
  profiles.set(profileId, {
    pages: new Set(),
    targets: new Map(),
    active: new Map(),
    ready: Promise.resolve(),
    changed: new Set(),
    activate,
    suspend,
    enabled,
    activating
  })
}

export function detachBrowserExtensionProfileDemand(profileId: string): void {
  profiles.delete(profileId)
}

export function hasBrowserExtensionProfileDemand(profileId: string): boolean {
  const demand = profiles.get(profileId)
  return Boolean(demand && (demand.pages.size > 0 || demand.targets.size > 0))
}

function reconcile(demand: ProfileDemand): Promise<void> {
  const desired = new Set([
    ...demand.targets.keys(),
    ...(demand.pages.size > 0 ? demand.enabled() : [])
  ])
  const retiring: Promise<void>[] = []
  let changed = false
  for (const id of demand.active.keys()) {
    if (!desired.has(id)) {
      demand.active.delete(id)
      retiring.push(demand.suspend(id))
      changed = true
    }
  }
  for (const id of desired) {
    if (!demand.active.has(id)) {
      const target = { ready: demand.activate(id, demand.pages.size > 0), failed: false }
      void target.ready.catch(() => {
        target.failed = true
      })
      demand.active.set(id, target)
      changed = true
    }
  }
  if (changed) {
    // Terminal failures are recorded by their load; healthy targets still establish page readiness.
    demand.ready = Promise.allSettled(
      [...demand.active.values()].map((target) => target.ready)
    ).then(() => undefined)
    demand.activating?.(demand.ready)
    for (const listener of demand.changed) {
      listener()
    }
  }
  return Promise.all(retiring).then(() => undefined)
}

/** A missing target denotes an actual page, never a page-less explicit operation. */
export function acquireBrowserExtensionProfileDemand(
  profileId: string,
  extensionId?: string
): Owner | null {
  const demand = isBrowserExtensionSupportEnabled() && profiles.get(profileId)
  if (!demand) {
    return null
  }
  const owner = {}
  let owners = demand.pages
  if (extensionId !== undefined) {
    if (demand.active.get(extensionId)?.failed && !demand.targets.has(extensionId)) {
      demand.active.delete(extensionId)
    }
    owners = demand.targets.get(extensionId) ?? new Set()
    demand.targets.set(extensionId, owners)
  }
  owners.add(owner)
  void reconcile(demand).catch((error: unknown) =>
    console.warn('[browser-extensions] Could not suspend extensions:', error)
  )
  return {
    get ready() {
      return extensionId === undefined
        ? demand.ready
        : (demand.active.get(extensionId)?.ready ?? Promise.resolve())
    },
    changed: demand.changed,
    release: () => {
      if (!owners.delete(owner) || profiles.get(profileId) !== demand) {
        return Promise.resolve()
      }
      if (extensionId !== undefined && owners.size === 0) {
        demand.targets.delete(extensionId)
      }
      return reconcile(demand)
    }
  }
}

function pageDemand(contents: Electron.WebContents): Owner {
  const profileId = getBrowserSessionProfileIdentity(contents.session)
  return (profileId && acquireBrowserExtensionProfileDemand(profileId)) || noDemand()
}

function setPageOwner(page: Page, owner: Owner): void {
  page.detach()
  page.owner = owner
  const changed = (): void => {
    page.ready = owner.ready
    for (const listener of page.changed) {
      listener()
    }
  }
  owner.changed.add(changed)
  page.detach = () => {
    owner.changed.delete(changed)
  }
  changed()
}

/** Actual page factories own demand; native helpers and cookie clients never enter here. */
export function retainBrowserExtensionPage(contents: Electron.WebContents): Promise<void> {
  const existing = pages.get(contents)
  if (existing) {
    return existing.ready
  }
  const owner = pageDemand(contents)
  const page: Page = { owner, ready: owner.ready, changed: new Set(), detach: () => {} }
  pages.set(contents, page)
  setPageOwner(page, owner)
  const profileId = getBrowserSessionProfileIdentity(contents.session)
  if (profileId) {
    for (const listener of pageObservers) {
      listener(profileId)
    }
  }
  contents.once('destroyed', () => {
    const current = pages.get(contents)
    pages.delete(contents)
    current?.detach()
    current?.changed.clear()
    void current?.owner
      .release()
      .catch((error: unknown) =>
        console.warn('[browser-extensions] Could not suspend extensions:', error)
      )
  })
  return page.ready
}

/** Pending initial navigation follows setting changes and current target readiness. */
export function onBrowserExtensionPageReadiness(
  contents: Electron.WebContents,
  listener: (ready: Promise<void>) => void
): () => void {
  void retainBrowserExtensionPage(contents).catch(() => {})
  const page = pages.get(contents)!
  const changed = (): void => {
    listener(page.ready)
  }
  page.changed.add(changed)
  changed()
  return () => {
    page.changed.delete(changed)
  }
}

export function refreshBrowserExtensionPageDemand(): void {
  for (const [contents, page] of pages) {
    if (contents.isDestroyed()) {
      continue
    }
    void page.owner
      .release()
      .catch((error: unknown) =>
        console.warn('[browser-extensions] Could not suspend extensions:', error)
      )
    setPageOwner(page, pageDemand(contents))
  }
}

export function hasBrowserExtensionProfilePage(profileId: string): boolean {
  return (profiles.get(profileId)?.pages.size ?? 0) > 0
}

/** Observers see a real factory-acquired owner, never a helper or an extension request. */
export function onBrowserExtensionPageRetained(listener: (profileId: string) => void): () => void {
  pageObservers.add(listener)
  return () => {
    pageObservers.delete(listener)
  }
}

/** Explicit unload invalidates the attempt; its caller owns the subsequent enable/reload. */
export function forgetBrowserExtensionTargetDemand(profileId: string, extensionId: string): void {
  profiles.get(profileId)?.active.delete(extensionId)
}

/** Explicit installs/reloads publish their actual tracked prerequisite to pages using the same target. */
export function trackBrowserExtensionTargetReadiness(
  profileId: string,
  extensionId: string,
  ready: Promise<unknown>
): void {
  const demand = profiles.get(profileId)
  if (!demand) {
    return
  }
  const target = { ready: ready.then(() => undefined), failed: false }
  void target.ready.catch(() => {
    target.failed = true
  })
  demand.active.set(extensionId, target)
  demand.ready = Promise.allSettled([...demand.active.values()].map((item) => item.ready)).then(
    () => undefined
  )
  demand.activating?.(demand.ready)
  for (const listener of demand.changed) {
    listener()
  }
}
