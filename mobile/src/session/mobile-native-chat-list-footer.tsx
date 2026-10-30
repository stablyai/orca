import { Fragment, type ReactElement } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

type MobileNativeChatListRow = { item: NativeChatMessage; index: number }

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
