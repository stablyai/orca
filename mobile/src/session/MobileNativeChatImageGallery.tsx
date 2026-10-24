import { useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { NativeChatImageRefBlock } from '../../../src/shared/native-chat-types'
import { MobileNativeChatImage } from './MobileNativeChatImage'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { styles } from './mobile-native-chat-message-styles'

export function MobileNativeChatImageGallery({
  images,
  alignToEnd = true,
  onLongPress
}: {
  images: readonly NativeChatImageRefBlock[]
  alignToEnd?: boolean
  onLongPress?: () => void
}) {
  const { openImage } = useContext(MobileNativeChatRowOverlaysContext)
  const occurrences = new Map<string, number>()
  const thumbnails = images.slice(0, 3).map((image) => {
    const identity = image.path ?? image.url ?? image.alt ?? 'image'
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { image, key: `${identity}:${occurrence}` }
  })
  return (
    <View style={[styles.imageGallery, !alignToEnd && { justifyContent: 'flex-start' }]}>
      {thumbnails.map(({ image, key }, index) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={`Open image ${index + 1} of ${images.length}`}
          style={styles.imageGalleryTile}
          onLongPress={onLongPress}
          onPress={() =>
            openImage({
              uri: image.url ?? image.path ?? '',
              label: image.alt ?? 'Attached image',
              gallery: { images, initialIndex: index }
            })
          }
        >
          <MobileNativeChatImage
            uri={image.url ?? image.path}
            alt={image.alt}
            fontScale={1}
            imageStyle={styles.imageGalleryFill}
            resizeMode="cover"
          />
          {index === 2 && images.length > 3 ? (
            <View pointerEvents="none" style={styles.imageGalleryScrim}>
              <Text style={styles.imageGalleryOverflowCount}>+{images.length - 3}</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}
