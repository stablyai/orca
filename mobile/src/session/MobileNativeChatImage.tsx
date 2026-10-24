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
import {
  MobileNativeChatResourceContext,
  readMobileNativeChatResource
} from './mobile-native-chat-resource-read'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'
import { styles, TEXT_SIZE } from './mobile-native-chat-message-styles'

export function MobileNativeChatImage({
  uri,
  alt,
  fontScale,
  imageStyle = styles.imageThumb,
  resizeMode = 'contain',
  onLoad,
  onError
}: {
  uri: string | undefined
  alt?: string
  fontScale: number
  imageStyle?: StyleProp<ImageStyle>
  resizeMode?: ImageResizeMode
  onLoad?: ImageProps['onLoad']
  onError?: ImageProps['onError']
}) {
  const client = useContext(MobileNativeChatAttachmentContext)
  const resource = useContext(MobileNativeChatResourceContext)
  const direct = isRenderableImageUri(uri)
  const attachment =
    !direct && client !== null && uri !== undefined && isAgentSessionAttachmentStorePath(uri)
  const remote = attachment || (!direct && resource !== null && uri !== undefined)
  const owner = attachment ? client : resource
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{
    owner: typeof owner
    path: string
    uri: string | null
    error?: string
  } | null>(null)
  const [failed, setFailed] = useState<{
    owner: typeof owner
    path: string | undefined
    imageUri: string
  } | null>(null)
  useEffect(() => {
    if (!remote || uri === undefined) {
      return
    }
    let disposed = false
    const pending =
      attachment && client
        ? readMobileNativeChatAttachment(client, uri)
        : resource
          ? readMobileNativeChatResource(resource, uri)
          : Promise.resolve(null)
    void pending
      .then((image) => {
        if (!disposed) {
          setRead({ owner, path: uri, uri: image })
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRead({
            owner,
            path: uri,
            uri: null,
            error: error instanceof Error ? error.message : 'The session host is unavailable'
          })
        }
      })
    return () => {
      disposed = true
    }
  }, [client, resource, owner, attachment, uri, remote, attempt])
  const current = read?.owner === owner && read?.path === uri ? read : null
  const imageUri = direct ? uri : current?.uri
  const failedForCurrent =
    failed !== null && failed.owner === owner && failed.path === uri && failed.imageUri === imageUri
  if (imageUri && !failedForCurrent) {
    return (
      <Image
        source={{ uri: imageUri }}
        style={imageStyle}
        resizeMode={resizeMode}
        onLoad={onLoad}
        accessibilityLabel={alt ?? 'Attached image'}
        onError={(event) => {
          setFailed({ owner, path: uri, imageUri })
          onError?.(event)
        }}
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
        ? `${current?.error ?? 'Image unavailable'} · Tap to retry`
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
