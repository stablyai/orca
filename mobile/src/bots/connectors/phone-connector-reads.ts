// The connector reads a bot's surfaces share (Connectors, Needs you, Who can ask), by host: one cell
// each, so a fix on one shows on the others at once, as the desktop's one read per bot does.
import { useEffect, useState, useSyncExternalStore } from 'react'

/** A read's last answer and whatever its reader keeps beside it to order its reads. */
export type ConnectorReadCell<T> = { value: T }

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One read's cells by key ("<hostKey>\0<read>\0<botId>"), each made by `create` when first asked for. */
export function connectorReadCells<C extends ConnectorReadCell<unknown>>(
  create: () => C
): (key: string) => C {
  const cells = new Map<string, C>()
  return (key) => {
    let cell = cells.get(key)
    if (!cell) {
      cell = create()
      cells.set(key, cell)
    }
    return cell
  }
}

export function setConnectorRead<T>(cell: ConnectorReadCell<T>, value: T): void {
  cell.value = value
  listeners.forEach((listener) => listener())
}

export function useConnectorRead<T>(cell: ConnectorReadCell<T>): T {
  const read = () => cell.value
  return useSyncExternalStore(subscribe, read, read)
}

export const connectorReadKey = (hostKey: string, read: string, botId = ''): string =>
  `${hostKey}\u0000${read}\u0000${botId}`

const READ_EVERY_MS = 60_000

/** The route's read count, moved on at most once a minute: each read is an Orca Cloud call on the
 *  host, and the route reads on every change of the bot's work. */
export function useReadsAtMostEveryMinute(reads: number): number {
  const [passed, setPassed] = useState({ reads, at: 0 })
  useEffect(() => {
    const now = Date.now()
    if (reads !== passed.reads && now - passed.at >= READ_EVERY_MS) {
      setPassed({ reads, at: now })
    }
  }, [reads, passed])
  return passed.reads
}
