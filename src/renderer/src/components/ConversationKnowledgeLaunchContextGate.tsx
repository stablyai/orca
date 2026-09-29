import { useEffect } from 'react'
import { replaceConversationKnowledgeLaunchItems } from '@/lib/conversation-knowledge-launch-context'
import { useAppStore } from '@/store'

export function ConversationKnowledgeLaunchContextGate(): null {
  const enabled = useAppStore((state) => state.settings?.conversationKnowledgeEnabled === true)

  useEffect(() => {
    if (!enabled) {
      replaceConversationKnowledgeLaunchItems([])
      return
    }
    let disposed = false
    const refresh = (): void => {
      void window.api.aiVault
        .listKnowledge()
        .then(({ items }) => {
          if (!disposed) {
            replaceConversationKnowledgeLaunchItems(items)
          }
        })
        .catch((error) => {
          console.error('[conversation-knowledge] Failed to refresh launch context:', error)
        })
    }
    refresh()
    const unsubscribe = window.api.aiVault.onWindowFocused(refresh)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [enabled])

  return null
}
