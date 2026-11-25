import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { StructuredAgentSendingSource } from '../../../../../../src/shared/agent-session/view/structured-agent-sending-source'

const noSubscription = () => () => {}
const notPending = () => false

type Gate = ReturnType<StructuredAgentSendingSource['gateFor']>
const SendingContext = createContext<
  { source: StructuredAgentSendingSource; ids: ReadonlySet<string>; gate: Gate } | undefined
>(undefined)

export function StructuredAgentSendingScope({
  source,
  displayedIds,
  children
}: {
  source?: StructuredAgentSendingSource
  displayedIds: ReadonlySet<string>
  children?: ReactNode
}): ReactNode {
  const sending = useMemo(
    () => source && { source, ids: displayedIds, gate: source.gateFor(displayedIds) },
    [source, displayedIds]
  )
  return <SendingContext value={sending}>{children}</SendingContext>
}

export function useStructuredAgentItemSending(id: string | undefined): boolean {
  const context = useContext(SendingContext)
  const source = id !== undefined && context?.ids.has(id) ? context.source : undefined
  const subscribe = useCallback(
    (listener: () => void) =>
      id === undefined ? noSubscription() : (source?.subscribeId(id, listener) ?? noSubscription()),
    [id, source]
  )
  return useSyncExternalStore(subscribe, () => id !== undefined && source?.getId(id) === true)
}

export function useStructuredAgentDisplayedSendPending(): boolean {
  const gate = useContext(SendingContext)?.gate
  return useSyncExternalStore(gate?.subscribe ?? noSubscription, gate?.getSnapshot ?? notPending)
}

export function StructuredAgentWorkingGate({
  children,
  whileSending = false
}: {
  children: ReactNode
  whileSending?: boolean
}): ReactNode {
  return useStructuredAgentDisplayedSendPending() === whileSending ? children : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const NO_ROWS: readonly string[] = []

export function useSendingRowIds<Row>(rows: readonly Row[], idOf: (row: Row) => string) {
  const committed = useRef(NO_ROWS)
  const ids = useMemo(() => {
    const previous = committed.current
    return previous.length === rows.length &&
      rows.every((row, index) => idOf(row) === previous[index])
      ? previous
      : rows.map(idOf)
  }, [rows, idOf])
  useLayoutEffect(() => {
    committed.current = ids
  }, [ids])
  return ids
}

export function useDisplayedSendingIds(
  source: StructuredAgentSendingSource | undefined,
  rows: readonly string[],
  waiting: readonly string[],
  window?: { first: number; heldFrom: number; heldAt: number },
  frozen?: { rowIds: readonly string[]; waitingIds: readonly string[] } | null
): ReadonlySet<string> {
  const { first = 0, heldFrom = Infinity, heldAt = 0 } = window ?? {}
  const held = frozen?.rowIds ?? NO_ROWS
  const footer = frozen?.waitingIds ?? waiting
  const candidates = source?.candidates
  return useMemo(() => {
    if (!candidates?.size) {
      return EMPTY_IDS
    }
    return new Set(
      rows
        .slice(first, heldFrom)
        .concat(held.slice(Math.max(first, heldFrom) - heldAt), footer)
        .filter((id) => candidates.has(id))
    )
  }, [candidates, rows, footer, first, held, heldFrom, heldAt])
}
