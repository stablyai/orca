import { useContext, type ReactNode, type RefObject } from 'react'
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
  cancelRef,
  children
}: {
  micActive: boolean
  micStarting?: boolean
  micProcessing?: boolean
  cancelRef: RefObject<View | null>
  children: ReactNode
}): React.JSX.Element {
  const live = useContext(MobileDictationLiveContext)
  if (!live || (!micActive && !micProcessing)) {
    return <View style={styles.leadingControls}>{children}</View>
  }
  return (
    <View style={[styles.leadingControls, styles.dictationLeading]}>
      <MobileDictationCancelButton onCancel={live.cancel} targetRef={cancelRef} />
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
