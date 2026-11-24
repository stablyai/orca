import type { ReactNode } from 'react'
import type { NativeChatAwaitingInput } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-terminal-turn'
import { MobileNativeChatAwaitingInputRow } from '../messages/MobileNativeChatAwaitingInputRow'
import { MobileNativeChatLiveLine } from '../messages/MobileNativeChatLiveLine'

type LiveLineProps = React.ComponentProps<typeof MobileNativeChatLiveLine>

/** The parent's live row. A focused child hides it so the child transcript stays the page. */
export function mobileNativeChatLiveStatus({
  hidden,
  awaitingInput,
  line,
  onToggleReasoning,
  fontScale
}: {
  hidden: boolean
  awaitingInput: NativeChatAwaitingInput | null
  line: LiveLineProps['line'] | null
  onToggleReasoning: LiveLineProps['onToggleReasoning']
  fontScale: number
}): ReactNode {
  if (hidden) {
    return null
  }
  if (awaitingInput === 'unshown') {
    return <MobileNativeChatAwaitingInputRow subject={null} pending fontScale={fontScale} />
  }
  if (!line) {
    return null
  }
  return (
    <MobileNativeChatLiveLine
      line={line}
      onToggleReasoning={onToggleReasoning}
      fontScale={fontScale}
    />
  )
}
