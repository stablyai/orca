import { Fragment, type ReactElement } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

type MobileNativeChatListRow = { item: NativeChatMessage; index: number }

/** The live turn's status, then the messages waiting behind that turn, drawn below it. */
export function mobileNativeChatListFooter(
  liveStatus: ReactElement | null,
  waitingRows: readonly MobileNativeChatListRow[],
  renderRow: (row: MobileNativeChatListRow) => ReactElement
): ReactElement | null {
  if (waitingRows.length === 0) {
    return liveStatus
  }
  return (
    <>
      {liveStatus}
      {waitingRows.map((row) => (
        <Fragment key={row.item.id}>{renderRow(row)}</Fragment>
      ))}
    </>
  )
}
