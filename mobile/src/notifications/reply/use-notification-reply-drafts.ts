import { recoverNotificationReplyDrafts } from './notification-reply-draft-recovery'
import { useEffect } from 'react'
import { usePageBridgeClientIfPresent } from '../../transport/connection/client-context.web'
import { readPageDeviceStore } from '../../mobile-web-shell/bridge/page-storage/page-device-store'
import { restoreNotificationReplyDrafts } from './notification-reply-draft-handoff'

export function useNotificationReplyDrafts(
  scope: string | null,
  apply: (text: string) => Promise<boolean>
): void {
  const client = usePageBridgeClientIfPresent()
  useEffect(() => {
    if (!scope || !client) {
      return
    }
    let recovery: AbortController | null = null
    const restore = () => {
      recovery?.abort()
      const current = new AbortController()
      recovery = current
      void recoverNotificationReplyDrafts(async () => {
        const store = readPageDeviceStore()
        if (!store?.available()) {
          return false
        }
        return restoreNotificationReplyDrafts(store, scope, (text) =>
          current.signal.aborted ? Promise.resolve(false) : apply(text)
        )
      }, current.signal).catch(() => {})
    }
    restore()
    const stop = client.onRouteUpdate(restore)
    return () => {
      recovery?.abort()
      stop()
    }
  }, [apply, client, scope])
}
