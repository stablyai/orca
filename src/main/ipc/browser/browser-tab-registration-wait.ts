import { webContents } from 'electron'
// oxlint-disable-next-line import/no-cycle -- browser subsystem singleton hub (browserManager); breaking it needs DI and test-mock updates, left for a human
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { onWorkspaceDocGuestRegistered } from '../../browser/document-preview/doc-preview-guest-policy'

// CLI commands wait for mounted guest registration; multiple startup callers may wait on one page.
const pendingTabRegistrations = new Map<string, Set<() => void>>()
const pendingWorktreeTabRegistrations = new Map<string, Set<() => void>>()
const pendingAnyTabRegistrations = new Set<() => void>()

function waitForRegistrationSet(
  registrationResolvers: Set<() => void>,
  timeoutMs: number,
  onEmpty: () => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const resolveRegistration = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      registrationResolvers.delete(resolveRegistration)
      if (registrationResolvers.size === 0) {
        onEmpty()
      }
      reject(new Error('Tab registration timed out'))
    }, timeoutMs)
    registrationResolvers.add(resolveRegistration)
  })
}

function resolvePendingRegistrations(registrationResolvers: Set<() => void> | undefined): void {
  if (!registrationResolvers) {
    return
  }
  for (const pendingResolve of registrationResolvers) {
    pendingResolve()
  }
}

export function isLiveBrowserWebContentsId(webContentsId: number | null | undefined): boolean {
  if (webContentsId == null) {
    return false
  }
  const guest = webContents.fromId(webContentsId)
  return Boolean(guest && !guest.isDestroyed())
}

function hasRegisteredTabForWorktree(worktreeId: string): boolean {
  for (const [browserPageId, webContentsId] of browserManager.getWebContentsIdByTabId()) {
    if (
      browserManager.getWorktreeIdForTab(browserPageId) === worktreeId &&
      isLiveBrowserWebContentsId(webContentsId)
    ) {
      return true
    }
  }
  return false
}

// Pages whose guest waits for its profile's extensions; kept a while after, for timers spanning that.
type ExtensionWait = { done: Promise<void>; endedAt: number | null }
const extensionWaits = new Map<string, ExtensionWait>()
const EXTENSION_WAIT_MEMORY_MS = 30_000
let activeExtensionWaits = 0
let lastExtensionWaitEndedAt = 0
let allExtensionWaitsSettled: Promise<void> = Promise.resolve()
let settleAllExtensionWaits = (): void => {}

/** A page whose guest waits for its profile's extensions: registration waits get their time after it. */
export function noteBrowserPageWaitingForExtensions(
  browserPageId: string,
  wait: Promise<void>
): void {
  const entry: ExtensionWait = { done: wait.catch(() => {}), endedAt: null }
  extensionWaits.set(browserPageId, entry)
  if (activeExtensionWaits++ === 0) {
    allExtensionWaitsSettled = new Promise((resolve) => (settleAllExtensionWaits = resolve))
  }
  void entry.done.then(() => {
    entry.endedAt = lastExtensionWaitEndedAt = Date.now()
    if (--activeExtensionWaits === 0) {
      settleAllExtensionWaits()
    }
    setTimeout(() => {
      if (extensionWaits.get(browserPageId) === entry) {
        extensionWaits.delete(browserPageId)
      }
    }, EXTENSION_WAIT_MEMORY_MS).unref?.()
  })
}

function extensionWaitSince(browserPageId: string, since: number): Promise<void> | null {
  const entry = extensionWaits.get(browserPageId)
  return entry && (entry.endedAt === null || entry.endedAt >= since) ? entry.done : null
}

export function waitForTabRegistration(browserPageId: string, timeoutMs = 8_000): Promise<void> {
  if (isLiveBrowserWebContentsId(browserManager.getGuestWebContentsId(browserPageId))) {
    return Promise.resolve()
  }
  const since = Date.now()
  // A page that waited for its extensions during this time gets its full time after that wait.
  return waitForNextTabRegistration(browserPageId, timeoutMs).catch((error: unknown) => {
    const extensions = extensionWaitSince(browserPageId, since)
    if (!extensions) {
      throw error
    }
    return extensions.then(() => waitForTabRegistration(browserPageId, timeoutMs))
  })
}

export function waitForNextTabRegistration(
  browserPageId: string,
  timeoutMs: number
): Promise<void> {
  let registrationResolvers = pendingTabRegistrations.get(browserPageId)
  if (!registrationResolvers) {
    registrationResolvers = new Set()
    pendingTabRegistrations.set(browserPageId, registrationResolvers)
  }
  return waitForRegistrationSet(registrationResolvers, timeoutMs, () => {
    pendingTabRegistrations.delete(browserPageId)
  })
}

export function waitForWorktreeTabRegistration(
  worktreeId: string | undefined,
  timeoutMs = 8_000
): Promise<void> {
  const since = Date.now()
  return waitForWorktreeTabRegistrationOnce(worktreeId, timeoutMs).catch((error: unknown) => {
    // A page still waiting for its extensions may be this worktree's (its worktree is known only
    // once it registers): keep listening, and give it its full time once those waits end.
    if (activeExtensionWaits === 0 && lastExtensionWaitEndedAt < since) {
      throw error
    }
    return Promise.any([
      waitForWorktreeTabRegistrationOnce(worktreeId, timeoutMs),
      allExtensionWaitsSettled.then(() => waitForWorktreeTabRegistrationOnce(worktreeId, timeoutMs))
    ]).catch(() => {
      throw error
    })
  })
}

function waitForWorktreeTabRegistrationOnce(
  worktreeId: string | undefined,
  timeoutMs: number
): Promise<void> {
  if (!worktreeId) {
    return waitForAnyTabRegistration(timeoutMs)
  }
  if (hasRegisteredTabForWorktree(worktreeId)) {
    return Promise.resolve()
  }
  let registrationResolvers = pendingWorktreeTabRegistrations.get(worktreeId)
  if (!registrationResolvers) {
    registrationResolvers = new Set()
    pendingWorktreeTabRegistrations.set(worktreeId, registrationResolvers)
  }
  return waitForRegistrationSet(registrationResolvers, timeoutMs, () => {
    pendingWorktreeTabRegistrations.delete(worktreeId)
  })
}

export function waitForAnyTabRegistration(timeoutMs = 8_000): Promise<void> {
  for (const webContentsId of browserManager.getWebContentsIdByTabId().values()) {
    if (isLiveBrowserWebContentsId(webContentsId)) {
      return Promise.resolve()
    }
  }
  return waitForRegistrationSet(pendingAnyTabRegistrations, timeoutMs, () => {})
}

// Documents satisfy only page-specific tools, never CLI/agent waits for a drivable browser tab.
onWorkspaceDocGuestRegistered((browserPageId) => {
  const pendingResolves = pendingTabRegistrations.get(browserPageId)
  pendingTabRegistrations.delete(browserPageId)
  resolvePendingRegistrations(pendingResolves)
})

export function resolveTabRegistrationWaiters(browserPageId: string, worktreeId: string): void {
  const pendingResolves = pendingTabRegistrations.get(browserPageId)
  pendingTabRegistrations.delete(browserPageId)
  resolvePendingRegistrations(pendingResolves)
  const pendingWorktreeResolves = pendingWorktreeTabRegistrations.get(worktreeId)
  pendingWorktreeTabRegistrations.delete(worktreeId)
  resolvePendingRegistrations(pendingWorktreeResolves)
  const pendingAnyResolves = new Set(pendingAnyTabRegistrations)
  pendingAnyTabRegistrations.clear()
  resolvePendingRegistrations(pendingAnyResolves)
}

/** Resolves once a registered page's first navigation stops, or after the timeout; never rejects. */
export function waitForTabFirstLoad(browserPageId: string, timeoutMs = 10_000): Promise<void> {
  const id = browserManager.getGuestWebContentsId(browserPageId)
  const guest = id == null ? null : webContents.fromId(id)
  // Why the URL: a guest that registered before its src applied reports '' and is not loading yet.
  if (!guest || guest.isDestroyed() || (!guest.isLoading() && guest.getURL() !== '')) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      guest.off('did-stop-loading', done)
      guest.off('destroyed', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    guest.on('did-stop-loading', done)
    guest.on('destroyed', done)
  })
}
