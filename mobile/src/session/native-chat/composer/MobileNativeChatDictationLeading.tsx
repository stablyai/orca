import { useContext, type ReactNode } from 'react'
import { View } from 'react-native'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'
import {
  MobileDictationCancelButton,
  MobileDictationFinishingNote,
  MobileDictationRecordingMeter
} from '../../../dictation/MobileDictationLiveControls'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

// While dictating, the row's leading side swaps attach and the pickers for ✕ and the meter, so the composer keeps its height.
export function MobileNativeChatDictationLeading({
  micActive,
  micStarting = false,
  micProcessing = false,
  children
}: {
  micActive: boolean
  micStarting?: boolean
  micProcessing?: boolean
  children: ReactNode
}): React.JSX.Element {
  const live = useContext(MobileDictationLiveContext)
  if (!live || (!micActive && !micProcessing)) {
    return <View style={styles.leadingControls}>{children}</View>
  }
  return (
    <View style={styles.leadingControls}>
      <MobileDictationCancelButton onCancel={live.cancel} targetRef={live.cancelRef} />
      {micProcessing ? (
        <MobileDictationFinishingNote engine={live.engine} computerName={live.computerName} />
      ) : micStarting ? null : (
        <MobileDictationRecordingMeter
          meter={live.meter}
          engine={live.engine}
          computerName={live.computerName}
          dotSize={5}
        />
      )}
    </View>
  )
}
