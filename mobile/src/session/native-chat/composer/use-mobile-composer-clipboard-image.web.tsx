import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useClipboardReader } from '../../../platform/clipboard'
import { usePageBridgeClientIfPresent } from '../../../transport/client-context.web'
import {
  mobileComposerPastedImageFromClipboardData,
  type MobileComposerPastedImage
} from './mobile-native-chat-composer-image-paste'

type ReadClipboardImage = () => Promise<MobileComposerPastedImage | null>

function MobileComposerClipboardImageSource({
  readRef
}: {
  readRef: RefObject<ReadClipboardImage | null>
}) {
  const clipboard = useClipboardReader()
  const read = useCallback(async (): Promise<MobileComposerPastedImage | null> => {
    const image = await clipboard.readImage()
    if (!image) {
      return null
    }
    return mobileComposerPastedImageFromClipboardData(image.data)
  }, [clipboard])
  useEffect(() => {
    readRef.current = read
    return () => {
      readRef.current = null
    }
  }, [read, readRef])
  return null
}

function MobileComposerClipboardImageHost({
  readRef
}: {
  readRef: RefObject<ReadClipboardImage | null>
}) {
  const client = usePageBridgeClientIfPresent()
  if (!client) {
    return null
  }
  return <MobileComposerClipboardImageSource readRef={readRef} />
}

export function useMobileComposerClipboardImageReader(): {
  readonly read: () => Promise<MobileComposerPastedImage | null>
  readonly host: ReactNode
} {
  const readRef = useRef<ReadClipboardImage | null>(null)
  const read = useCallback(async () => (await readRef.current?.()) ?? null, [])
  return { read, host: <MobileComposerClipboardImageHost readRef={readRef} /> }
}
