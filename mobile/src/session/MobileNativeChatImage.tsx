import { useContext, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  Text,
  View,
  type ImageStyle,
  type ImageProps,
  type StyleProp,
  type ImageResizeMode
} from 'react-native'
import { isAgentSessionAttachmentStorePath } from '../../../src/shared/agent-session-attachments'
import { colors } from '../theme/mobile-theme'
import {
  MobileNativeChatAttachmentContext,
  readMobileNativeChatAttachment
} from './mobile-native-chat-attachment-read'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'

export function MobileNativeChatImage({
  uri,
  alt,
  fontScale,
  imageStyle = styles.imageThumb,
  resizeMode = 'contain',
  onLoad
}: {
  uri: string | undefined
  alt?: string
  fontScale: number
  imageStyle?: StyleProp<ImageStyle>
  resizeMode?: ImageResizeMode
  onLoad?: ImageProps['onLoad']
}) {
  const client = useContext(MobileNativeChatAttachmentContext)
  const direct = isRenderableImageUri(uri)
  const remote =
    !direct && client !== null && uri !== undefined && isAgentSessionAttachmentStorePath(uri)
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{
    client: typeof client
    path: string
    uri: string | null
  } | null>(null)
  const [failed, setFailed] = useState<{
    client: typeof client
    path: string | undefined
    imageUri: string
  } | null>(null)
  useEffect(() => {
    if (!remote || !client || uri === undefined) {
      return
    }
    let disposed = false
    void readMobileNativeChatAttachment(client, uri)
      .catch(() => null)
      .then((image) => {
        if (!disposed) {
          setRead({ client, path: uri, uri: image })
        }
      })
    return () => {
      disposed = true
    }
  }, [client, uri, remote, attempt])
  const current = read?.client === client && read?.path === uri ? read : null
  const imageUri = direct ? uri : current?.uri
  const failedForCurrent =
    failed !== null &&
    failed.client === client &&
    failed.path === uri &&
    failed.imageUri === imageUri
  if (imageUri && !failedForCurrent) {
    return (
      <Image
        source={{ uri: imageUri }}
        style={imageStyle}
        resizeMode={resizeMode}
        onLoad={onLoad}
        accessibilityLabel={alt ?? 'Attached image'}
        onError={() => setFailed({ client, path: uri, imageUri })}
      />
    )
  }
  if (remote && current === null) {
    return (
      <View style={imageStyle}>
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading image" />
      </View>
    )
  }
  const label = (
    <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
      {remote || failedForCurrent
        ? 'Image unavailable · Tap to retry'
        : `🖼 ${alt ?? uri ?? 'image'}`}
    </Text>
  )
  return remote || failedForCurrent ? (
    <Pressable
      accessibilityLabel="Retry image"
      accessibilityRole="button"
      onPress={() => {
        setRead(null)
        setFailed(null)
        setAttempt((value) => value + 1)
      }}
    >
      {label}
    </Pressable>
  ) : (
    label
  )
}
