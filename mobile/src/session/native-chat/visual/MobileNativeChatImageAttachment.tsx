import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from 'react-native'
import type { NativeChatImageRefBlock } from '../../../../../src/shared/native-chat-types'
import { MobileNativeChatRowOverlaysContext } from '../transcript/mobile-native-chat-row-overlays'
import { isRenderableImageUri, readHostChatImage } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from '../transcript/mobile-native-chat-message-styles'

export function MobileNativeChatImageAttachment({
  block,
  fontScale,
  onLongPress
}: {
  block: NativeChatImageRefBlock
  fontScale: number
  onLongPress?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { openImage, imageSource } = useContext(MobileNativeChatRowOverlaysContext)
  const client = imageSource?.client
  const worktreeId = imageSource?.worktreeId
  const generation = client?.getGeneration?.() ?? 0
  const path = block.path
  const directUri = isRenderableImageUri(block.url)
    ? block.url
    : isRenderableImageUri(path)
      ? path
      : null
  const readable = !!client && !!path && !isRenderableImageUri(path) && !!worktreeId
  const [round, setRound] = useState(0)
  const [showSpinner, setShowSpinner] = useState(false)
  const source = useMemo(
    () => ({ client, worktreeId, generation, path, directUri }),
    [client, worktreeId, generation, path, directUri]
  )
  const [failedDirectSource, setFailedDirectSource] = useState<typeof source | null>(null)
  const usableDirectUri = failedDirectSource === source ? null : directUri
  const owner = useMemo(() => ({ source, round }), [source, round])
  const activeOwner = useRef<typeof owner | null>(owner)
  const [failedOwner, setFailedOwner] = useState<typeof owner | null>(null)
  const [preview, setPreview] = useState<{
    owner: typeof owner
    uri: string | null
  } | null>(null)
  const current = preview?.owner === owner ? preview : null

  useEffect(() => {
    activeOwner.current = owner
    return () => {
      activeOwner.current = null
    }
  }, [owner])

  useEffect(() => {
    if (usableDirectUri || !client || !imageSource || !path || !readable) {
      return
    }
    const unmounted = new AbortController()
    setShowSpinner(false)
    const timer = setTimeout(() => {
      if (!unmounted.signal.aborted) {
        setShowSpinner(true)
      }
    }, 200)
    void readHostChatImage(imageSource, path, unmounted.signal).then((uri) => {
      clearTimeout(timer)
      if (!unmounted.signal.aborted && (client.getGeneration?.() ?? 0) === generation) {
        setPreview({ owner, uri })
      }
    })
    return () => {
      unmounted.abort()
      clearTimeout(timer)
    }
  }, [client, generation, path, usableDirectUri, owner, readable, imageSource])

  const uri = usableDirectUri ?? current?.uri
  const label = block.alt ?? t('chat.nativeChatProse.attachedImage', 'Attached image')
  if (uri && failedOwner !== owner) {
    return (
      <Pressable
        onPress={() => openImage({ uri, label })}
        onLongPress={onLongPress}
        accessibilityRole={Platform.OS === 'web' ? 'button' : 'imagebutton'}
        accessibilityLabel={label}
        accessibilityHint={t('chat.nativeChatProse.openImageHint', 'Opens the image full size')}
      >
        <Image
          key={`${round}:${usableDirectUri ? 'direct' : 'stored'}`}
          source={{ uri }}
          style={styles.imageThumb}
          resizeMode="contain"
          onError={() => {
            if (activeOwner.current !== owner || (client?.getGeneration?.() ?? 0) !== generation) {
              return
            }
            if (usableDirectUri && readable) {
              setFailedDirectSource(source)
            } else {
              setFailedOwner(owner)
            }
          }}
        />
      </Pressable>
    )
  }
  if (readable && !current && !usableDirectUri) {
    return (
      <View
        style={[styles.imageThumb, styles.imageLoading]}
        accessibilityLabel={t('chat.nativeChatProse.loadingImage', 'Loading image')}
      >
        {showSpinner ? <ActivityIndicator /> : null}
      </View>
    )
  }
  if (readable || directUri) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.nativeChatProse.imageUnavailable', 'Image unavailable')}
        accessibilityHint={t('chat.nativeChatProse.retryImageHint', 'Tries to load it again')}
        onLongPress={onLongPress}
        onPress={() => {
          setRound((value) => value + 1)
        }}
      >
        <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
          {t('chat.nativeChatProse.retryImage', 'Image unavailable — tap to retry')}
        </Text>
      </Pressable>
    )
  }
  return (
    <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
      🖼 {block.alt ?? block.path ?? block.url ?? t('chat.nativeChatProse.image', 'image')}
    </Text>
  )
}
