import { Fragment, type ReactElement } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatAwaitingInput } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-terminal-turn'
import { StructuredAgentWorkingGate } from '../../../../../../src/shared/agent-session/view/use-structured-agent-sending'
import { MobileNativeChatLiveLine } from '../messages/MobileNativeChatLiveLine'
import { MobileNativeChatAwaitingInputRow } from '../messages/MobileNativeChatAwaitingInputRow'
import type { useMobileNativeChatTurnDisclosure } from '../turn-state/use-mobile-native-chat-turn-disclosure'

type MobileNativeChatListRow = { item: NativeChatMessage; index: number }

export function mobileNativeChatFooterStatus(
  {
    liveLine,
    onToggleReasoning
  }: Pick<ReturnType<typeof useMobileNativeChatTurnDisclosure>, 'liveLine' | 'onToggleReasoning'>,
  fontScale: number,
  awaitingInput: NativeChatAwaitingInput | null
): ReactElement | null {
  if (awaitingInput === 'unshown') {
    return <MobileNativeChatAwaitingInputRow subject={null} pending fontScale={fontScale} />
  }
  if (!liveLine) {
    return null
  }
  return (
    <StructuredAgentWorkingGate>
      <MobileNativeChatLiveLine line={liveLine} {...{ onToggleReasoning, fontScale }} />
    </StructuredAgentWorkingGate>
  )
}

export function mobileNativeChatListFooter(
  liveStatus: ReactElement | null,
  waitingRows: readonly MobileNativeChatListRow[],
  renderRow: (row: MobileNativeChatListRow) => ReactElement,
  /** Other agents' waiting mail, last: it is not part of the turn (it draws nothing when none waits). */
  agentMail?: ReactElement | null
): ReactElement | null {
  if (waitingRows.length === 0 && !agentMail) {
    return liveStatus
  }
  return (
    <>
      {liveStatus}
      {waitingRows.map((row) => (
        <Fragment key={row.item.id}>{renderRow(row)}</Fragment>
      ))}
      {agentMail}
    </>
  )
}
