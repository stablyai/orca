import { Fragment, useCallback, useMemo, useState, type ReactElement } from 'react'
import { Platform } from 'react-native'

const NO_ROWS: readonly never[] = []

type Row<TItem> = { item: TItem; index: number }

/** RN Web's list draws rows by index, so rows added at the front push the ones a reader is on out
 *  of what it draws. On the page, rows that arrive above the list's first row go in its header
 *  instead: the list's own rows keep their indexes and stay drawn. */
export function useMobileNativeChatPageHistory<TItem extends { id: string }>(
  rows: readonly TItem[],
  renderRow: (row: Row<TItem>) => ReactElement,
  /** The chat shown: synthetic row ids (the streaming bubble, an echo) repeat across chats. */
  scopeKey: string
): {
  listRows: readonly TItem[]
  renderListRow: (row: Row<TItem>) => ReactElement
  /** The list header: what was given, then the history loaded above the list's own rows. */
  withHistory: (header: ReactElement | null) => ReactElement | null
} {
  const onPage = Platform.OS === 'web'
  // The row the list starts at, for as long as that row exists in this chat.
  const [head, setHead] = useState<{ scopeKey: string; id: string } | null>(null)
  const headId = head?.scopeKey === scopeKey ? head.id : null
  const headIndex = useMemo(
    () => (onPage && headId !== null ? rows.findIndex((row) => row.id === headId) : -1),
    [onPage, headId, rows]
  )
  const firstId = rows[0]?.id
  if (onPage && headIndex === -1 && firstId !== undefined && firstId !== headId) {
    setHead({ scopeKey, id: firstId })
  }
  const historyCount = Math.max(headIndex, 0)
  const historyRows = useMemo(
    () => (historyCount === 0 ? NO_ROWS : rows.slice(0, historyCount)),
    [historyCount, rows]
  )
  const listRows = useMemo(
    () => (historyCount === 0 ? rows : rows.slice(historyCount)),
    [historyCount, rows]
  )
  const renderOffsetRow = useCallback(
    (row: Row<TItem>) => renderRow({ item: row.item, index: row.index + historyCount }),
    [renderRow, historyCount]
  )
  const withHistory = useCallback(
    (header: ReactElement | null) =>
      historyRows.length === 0 ? (
        header
      ) : (
        <>
          {header}
          {historyRows.map((item, index) => (
            <Fragment key={item.id}>{renderRow({ item, index })}</Fragment>
          ))}
        </>
      ),
    [historyRows, renderRow]
  )
  return {
    listRows,
    renderListRow: historyCount === 0 ? renderRow : renderOffsetRow,
    withHistory
  }
}
