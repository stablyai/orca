type DeferredRecoveryNotice = { sessionId: string; message: string }
const deferredRecoveryNotices = new Map<string, DeferredRecoveryNotice[]>()

export function deferMobileNativeChatRecoveryNotice(
  scope: string,
  sessionId: string,
  message: string
): void {
  const notices = deferredRecoveryNotices.get(scope) ?? []
  notices.push({ sessionId, message })
  deferredRecoveryNotices.set(scope, notices)
}

export function reportDeferredMobileNativeChatRecoveryNotices(
  scope: string,
  sessionId: string,
  report: (message: string) => false | void
): void {
  const notices = deferredRecoveryNotices.get(scope)
  if (!notices) {
    return
  }
  const kept = notices.filter(
    (notice) => notice.sessionId !== sessionId || report(notice.message) === false
  )
  if (kept.length) {
    deferredRecoveryNotices.set(scope, kept)
  } else {
    discardMobileNativeChatRecoveryNotices(scope)
  }
}

export function discardMobileNativeChatRecoveryNotices(scope: string): void {
  deferredRecoveryNotices.delete(scope)
}
