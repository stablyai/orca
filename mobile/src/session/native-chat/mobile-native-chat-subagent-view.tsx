import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatSubagentActivity } from '../../../../src/shared/native-chat/input/native-chat-activity'
import { MobileNativeChatActivityBar } from './input/MobileNativeChatActivityBar'
import { MobileNativeChatOpenSubagentProvider } from './input/mobile-native-chat-open-subagent'
import type { MobileDismissedSubagentScope } from './input/use-mobile-dismissed-subagents'
import type { MobileNativeChatSubagentRead } from './input/use-mobile-native-chat-subagent-page'
import { useMobileNativeChatSubagentTranscript } from './input/use-mobile-native-chat-subagent-transcript'
import { MobileNativeChatView } from './MobileNativeChatView'
import type { MobileNativeChatViewProps } from './mobile-native-chat-view-props'

/** The conversation, or one child's framed transcript, with the roster above the composer. */
export function MobileNativeChatSubagentView({
  subagentSeed = null,
  readSubagentPage = null,
  dismissalScope = null,
  ...viewProps
}: MobileNativeChatViewProps & {
  subagentSeed?: readonly NativeChatSubagentActivity[] | null
  readSubagentPage?: MobileNativeChatSubagentRead | null
  dismissalScope?: MobileDismissedSubagentScope | null
}): React.JSX.Element {
  const subagent = useMobileNativeChatSubagentTranscript({
    messages: viewProps.messages,
    folded: viewProps.folded,
    streaming: viewProps.streaming,
    pending: viewProps.pending,
    imagePreviewsByMessageId: viewProps.imagePreviewsByMessageId,
    mainHistory: {
      hasMore: viewProps.hasMore,
      olderPages: viewProps.olderPages ?? 'idle',
      loadEarlier: viewProps.onLoadEarlier
    },
    agent: viewProps.agent,
    sendSurfaceId: viewProps.sendSurfaceId,
    subagentSeed,
    readSubagentPage
  })
  const focused = subagent.focusedId != null
  return (
    <MobileNativeChatOpenSubagentProvider onOpen={subagent.onFocusSubagent}>
      <MobileNativeChatView
        {...viewProps}
        messages={subagent.rowSource as NativeChatMessage[]}
        folded={subagent.shownFolded}
        streaming={subagent.shownStreaming}
        pending={subagent.shownPending}
        imagePreviewsByMessageId={focused ? undefined : viewProps.imagePreviewsByMessageId}
        hasMore={subagent.history.hasMore}
        olderPages={subagent.history.olderPages}
        onLoadEarlier={subagent.history.loadEarlier}
        listScopeKey={subagent.scopeKey}
        hideTranscriptChrome={focused}
        activityBar={
          <MobileNativeChatActivityBar {...subagent.activityBar} dismissalScope={dismissalScope} />
        }
      />
    </MobileNativeChatOpenSubagentProvider>
  )
}
