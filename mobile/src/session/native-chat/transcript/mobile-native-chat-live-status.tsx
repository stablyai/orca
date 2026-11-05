import type { NativeChatAwaitingInput } from '../../../../../src/shared/native-chat/native-chat-terminal-turn'
import { MobileNativeChatAwaitingInputRow } from './MobileNativeChatAwaitingInputRow'
import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'
import type { MobileNativeChatLiveLine as LiveLine } from './use-mobile-native-chat-turn-disclosure'

/** The trailing live row: an unshown prompt, or the running turn's line. Nothing while a child transcript is open. */
export function mobileNativeChatLiveStatus({
  hidden,
  awaitingInput,
  line,
  onToggleReasoning,
  fontScale
}: {
  hidden: boolean
  awaitingInput: NativeChatAwaitingInput | null | undefined
  line: LiveLine | null
  onToggleReasoning: ComponentLiveLineToggle
  fontScale: number
}): React.JSX.Element | null {
  if (hidden) {
    return null
  }
  if (awaitingInput === 'unshown') {
    return <MobileNativeChatAwaitingInputRow subject={null} pending fontScale={fontScale} />
  }
  return line ? (
    <MobileNativeChatLiveLine
      line={line}
      onToggleReasoning={onToggleReasoning}
      fontScale={fontScale}
    />
  ) : null
}

type ComponentLiveLineToggle = React.ComponentProps<
  typeof MobileNativeChatLiveLine
>['onToggleReasoning']
