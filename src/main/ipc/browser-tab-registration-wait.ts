import { webContents } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { onWorkspaceDocGuestRegistered } from '../browser/doc-preview-guest-policy'

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

export function waitForTabRegistration(browserPageId: string, timeoutMs = 8_000): Promise<void> {
  if (isLiveBrowserWebContentsId(browserManager.getGuestWebContentsId(browserPageId))) {
    return Promise.resolve()
  }
  return waitForNextTabRegistration(browserPageId, timeoutMs)
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
