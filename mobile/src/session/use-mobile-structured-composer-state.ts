import { useState } from 'react'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'

export function useMobileStructuredComposerState(): {
  composerText: string
  setComposerText: React.Dispatch<React.SetStateAction<string>>
  restored: PendingNativeChatImage[]
  setRestored: React.Dispatch<React.SetStateAction<PendingNativeChatImage[]>>
} {
  const [composerText, setComposerText] = useState('')
  const [restored, setRestored] = useState<PendingNativeChatImage[]>([])

  return { composerText, setComposerText, restored, setRestored }
}
