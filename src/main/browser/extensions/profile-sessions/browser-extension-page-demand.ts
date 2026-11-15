import { getBrowserSessionProfileIdentity } from '../../sessions/profiles/browser-session-profile-identity'
import {
  acquireBrowserExtensionProfileDemand,
  type BrowserExtensionProfileDemandOwner as Owner
} from './browser-extension-profile-demand'

const pageObservers = new Set<(profileId: string) => void>()
type Page = { owner: Owner; ready: Promise<void>; changed: Set<() => void>; detach: () => void }
const pages = new Map<Electron.WebContents, Page>()
const noDemand = (): Owner => ({
  ready: Promise.resolve(),
  release: () => Promise.resolve(),
  changed: new Set()
})

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

/** Observers see a real factory-acquired owner, never a helper or an extension request. */
export function onBrowserExtensionPageRetained(listener: (profileId: string) => void): () => void {
  pageObservers.add(listener)
  return () => {
    pageObservers.delete(listener)
  }
}
