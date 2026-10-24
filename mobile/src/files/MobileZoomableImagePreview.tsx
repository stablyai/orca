import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatZoomableImagePage } from '../session/MobileNativeChatZoomableImagePage'

const ignorePagingChange = () => {}
const styles = StyleSheet.create({ fill: { flex: 1 } })

/** File links and chat attachments share the same phone-page zoom gestures. */
export function MobileZoomableImagePreview({
  uri,
  label,
  onError
}: {
  uri: string
  label: string
  onError?: () => void
}) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const paging = useMemo(() => Gesture.Native(), [])
  return (
    <GestureHandlerRootView style={styles.fill}>
      <View
        style={styles.fill}
        onLayout={({ nativeEvent: { layout } }) =>
          setSize((previous) =>
            previous.width === layout.width && previous.height === layout.height ? previous : layout
          )
        }
      >
        {size.width > 0 && size.height > 0 ? (
          <MobileNativeChatZoomableImagePage
            key={uri}
            image={{ type: 'image-ref', url: uri, alt: label }}
            width={size.width}
            height={size.height}
            index={0}
            pagingGesture={paging}
            onInteractionChange={ignorePagingChange}
            onImageError={onError}
          />
        ) : null}
      </View>
    </GestureHandlerRootView>
  )
}
