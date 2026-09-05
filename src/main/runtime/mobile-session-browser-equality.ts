import type { RuntimeMobileSessionBrowserTab } from '../../shared/runtime-types'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'

// Why: change detection for headless browser tabs. Compares the fields that
// actually vary (a JSON.stringify equality was order-sensitive and silently
// dropped `undefined` keys, so it only worked while both sides shared one
// construction path).
export function headlessBrowserTabsUnchanged(
  live: RuntimeMobileSessionBrowserTab[],
  existing: RuntimeMobileSessionBrowserTab[]
): boolean {
  if (live.length !== existing.length) {
    return false
  }
  return live.every((tab, index) => {
    const prev = existing[index]
    return (
      tab.id === prev.id &&
      tab.title === prev.title &&
      tab.url === prev.url &&
      tab.loading === prev.loading &&
      tab.canGoBack === prev.canGoBack &&
      tab.canGoForward === prev.canGoForward &&
      tab.browserProfileId === prev.browserProfileId &&
      tab.executionHostKey === prev.executionHostKey &&
      ((tab.placement === undefined && prev.placement === undefined) ||
        (tab.placement !== undefined &&
          prev.placement !== undefined &&
          sameRuntimeBrowserPlacement(tab.placement, prev.placement))) &&
      tab.isActive === prev.isActive &&
      (tab.isPinned ?? false) === (prev.isPinned ?? false) &&
      (tab.color ?? null) === (prev.color ?? null) &&
      browserLoadErrorsEqual(tab.loadError, prev.loadError) &&
      browserCertificateFailuresEqual(tab.certificateFailure, prev.certificateFailure)
    )
  })
}

export function browserLoadErrorsEqual(
  a: RuntimeMobileSessionBrowserTab['loadError'],
  b: RuntimeMobileSessionBrowserTab['loadError']
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return (
    left.code === right.code &&
    left.description === right.description &&
    left.validatedUrl === right.validatedUrl
  )
}

export function browserCertificateFailuresEqual(
  a: RuntimeMobileSessionBrowserTab['certificateFailure'],
  b: RuntimeMobileSessionBrowserTab['certificateFailure']
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return (
    left.challengeId === right.challengeId &&
    left.browserPageId === right.browserPageId &&
    left.errorCode === right.errorCode &&
    left.error === right.error &&
    left.origin === right.origin &&
    left.displayHost === right.displayHost &&
    left.canProceed === right.canProceed &&
    left.observedAt === right.observedAt
  )
}
