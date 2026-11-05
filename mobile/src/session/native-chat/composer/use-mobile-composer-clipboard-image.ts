import type { ReactNode } from 'react'
import type { MobileComposerPastedImage } from './mobile-native-chat-composer-image-paste'

// The page bundle reads UIPasteboard through the shell. Native text fields have no DOM paste.
export function useMobileComposerClipboardImageReader(): {
  readonly read: () => Promise<MobileComposerPastedImage | null>
  readonly host: ReactNode
} {
  return {
    read: async () => null,
    host: null
  }
}
