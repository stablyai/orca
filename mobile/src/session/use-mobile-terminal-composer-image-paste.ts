import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

// Native fields keep the system paste. The web page claims image-only pastes.
export function useMobileTerminalComposerImagePaste(_args: {
  readonly enabled: boolean
  readonly fieldRefs: readonly RefObject<TextInput | null>[]
  readonly onImagePaste: () => void
  readonly readClipboardImage: () => Promise<{ base64: string } | null>
}): void {}
