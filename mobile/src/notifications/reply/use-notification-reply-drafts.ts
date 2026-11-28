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
    const store = readPageDeviceStore()
    if (!scope || !store?.available() || !client) {
      return
    }
    let active = true
    const restore = () => {
      void restoreNotificationReplyDrafts(store, scope, (text) =>
        active ? apply(text) : Promise.resolve(false)
      ).catch(() => {})
    }
    restore()
    const stop = client.onRouteUpdate(restore)
    return () => {
      active = false
      stop()
    }
  }, [apply, client, scope])
}
