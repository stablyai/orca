import { Fragment, type ReactElement } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

type MobileNativeChatListRow = { item: NativeChatMessage; index: number }

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
