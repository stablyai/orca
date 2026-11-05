import type { ComponentProps } from 'react'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileNativeChatScrollRootsBoundary } from '../MobileNativeChatScrollRootsBoundary'
import { MobileNativeChatFloatingControls } from './MobileNativeChatFloatingControls'
import { MobileNativeChatDisclosureContext } from './transcript/mobile-native-chat-disclosure-store'
import { MobileNativeChatOpenSubagentProvider } from './input/mobile-native-chat-open-subagent'
import { MobileNativeChatRowList } from './transcript/MobileNativeChatRowList'
import type { useMobileNativeChatDisclosures } from './transcript/mobile-native-chat-disclosure-store'
import type { useMobileNativeChatRowKeys } from './transcript/mobile-native-chat-row-keys'
import type { useMobileNativeChatPinchGesture } from './transcript/use-mobile-native-chat-pinch-gesture'
import type { useMobileNativeChatTurnDisclosure } from './transcript/use-mobile-native-chat-turn-disclosure'
import { styles } from './mobile-native-chat-view-styles'

type RowListProps = ComponentProps<typeof MobileNativeChatRowList>

export function MobileNativeChatTranscriptPane({
  disclosures,
  turns,
  pinchGesture,
  onOpenSubagent,
  jumpToTail,
  rowKeys,
  layoutKey,
  ...rowList
}: Omit<RowListProps, 'rows' | 'runs' | 'roots' | 'contentContainerStyle' | 'rowKeys'> & {
  rowKeys: ReturnType<typeof useMobileNativeChatRowKeys>
  disclosures: ReturnType<typeof useMobileNativeChatDisclosures>
  turns: ReturnType<typeof useMobileNativeChatTurnDisclosure>
  pinchGesture: ReturnType<typeof useMobileNativeChatPinchGesture>['pinchGesture']
  onOpenSubagent: ComponentProps<typeof MobileNativeChatOpenSubagentProvider>['onOpen']
  jumpToTail: () => void
}): React.JSX.Element {
  return (
    <GestureHandlerRootView style={styles.listWrap}>
      <MobileNativeChatDisclosureContext.Provider value={disclosures}>
        <MobileNativeChatOpenSubagentProvider onOpen={onOpenSubagent}>
          <MobileNativeChatScrollRootsBoundary
            {...{ rowKeys, layoutKey }}
            roots={disclosures.roots}
            runPlacements={rowKeys.runPlacements}
          >
            <GestureDetector gesture={pinchGesture}>
              <MobileNativeChatRowList
                {...rowList}
                {...{ rowKeys, layoutKey }}
                rows={turns.listMessages}
                runs={turns.presentation.workRuns.heads}
                roots={disclosures.roots}
                contentContainerStyle={styles.listContent}
              />
            </GestureDetector>
          </MobileNativeChatScrollRootsBoundary>
        </MobileNativeChatOpenSubagentProvider>
      </MobileNativeChatDisclosureContext.Provider>
      <MobileNativeChatFloatingControls
        showJumpToTail={rowList.tail.showJumpToTail}
        onJumpToTail={jumpToTail}
      />
    </GestureHandlerRootView>
  )
}
