import { useCallback, useContext, useState, type ReactNode, type RefObject } from 'react'
import { View, type HostInstance, type LayoutChangeEvent } from 'react-native'
import { MobileDictationLiveContext } from '../../../../dictation/mobile-dictation-live-context'
import {
  MobileDictationCancelButton,
  MobileDictationFailureNote,
  MobileDictationFinishingNote,
  MobileDictationRecordingMeter
} from '../../../../dictation/MobileDictationLiveControls'
import {
  COMPOSER_ATTACH_AND_MODEL_MIN_WIDTH,
  mobileNativeChatComposerStyles as styles
} from '../field/mobile-native-chat-composer-styles'

// While dictating, the row's leading side swaps attach and the pickers for ✕ and the meter (or a kept failure), so the composer keeps its height.
export function MobileNativeChatDictationLeading({
  micActive,
  micStarting = false,
  micProcessing = false,
  cancelRef,
  trailing,
  attachAndModel,
  stackOnNarrowWidth,
  children
}: {
  micActive: boolean
  micStarting?: boolean
  micProcessing?: boolean
  cancelRef: RefObject<HostInstance | null>
  // The context ring after the leading controls; it steps aside with them.
  trailing: ReactNode
  attachAndModel?: ReactNode
  stackOnNarrowWidth?: boolean
  children: ReactNode
}): React.JSX.Element {
  const live = useContext(MobileDictationLiveContext)
  const [narrow, setNarrow] = useState(false)
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setNarrow(event.nativeEvent.layout.width < COMPOSER_ATTACH_AND_MODEL_MIN_WIDTH)
  }, [])
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
        <View style={styles.leadingControls} onLayout={stackOnNarrowWidth ? onLayout : undefined}>
          {attachAndModel ? (
            <View
              style={[
                styles.attachAndModel,
                stackOnNarrowWidth && narrow && styles.stackedAttachAndModel
              ]}
            >
              {attachAndModel}
            </View>
          ) : null}
          {children}
        </View>
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
