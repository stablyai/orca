import { useContext, type ReactNode, type RefObject } from 'react'
import { View, type HostInstance } from 'react-native'
import { MobileDictationLiveContext } from '../../../../dictation/mobile-dictation-live-context'
import {
  MobileDictationCancelButton,
  MobileDictationFailureNote,
  MobileDictationFinishingNote,
  MobileDictationRecordingMeter
} from '../../../../dictation/MobileDictationLiveControls'
import { mobileNativeChatComposerStyles as styles } from '../field/mobile-native-chat-composer-styles'

// While dictating, the row's leading side swaps attach and the pickers for ✕ and the meter (or a kept failure), so the composer keeps its height.
export function MobileNativeChatDictationLeading({
  micActive,
  micStarting = false,
  micProcessing = false,
  cancelRef,
  trailing,
  children
}: {
  micActive: boolean
  micStarting?: boolean
  micProcessing?: boolean
  cancelRef: RefObject<HostInstance | null>
  // The context ring after the leading controls; it steps aside with them.
  trailing: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const live = useContext(MobileDictationLiveContext)
  if (live?.failureReason != null) {
    return (
      <View style={[styles.leadingControls, styles.dictationLeading]}>
        <MobileDictationCancelButton onCancel={live.cancel} discards />
        <MobileDictationFailureNote reason={live.failureReason} />
      </View>
    )
  }
  if (!live || (!micActive && !micProcessing)) {
    return (
      <>
        <View style={styles.leadingControls}>{children}</View>
        {trailing}
      </>
    )
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

// A dictation failed with its recording kept: Send gives its room to Retry.
export function useMobileNativeChatDictationFailed(): boolean {
  return useContext(MobileDictationLiveContext)?.failureReason != null
}
