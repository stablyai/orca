import type {
  JournalSqlReaderCancellation,
  JournalSqlReaderRequest
} from './journal-sql-reader-protocol'

/** Keep the SQLite snapshot exclusive while permitting cancellation between export pages. */
export function createJournalSqlReaderDispatch(
  handle: (
    id: number,
    operation: JournalSqlReaderRequest['operation'],
    signal?: AbortSignal
  ) => Promise<void>
) {
  let requests = Promise.resolve()
  const inFlight = new Map<number, AbortController>()
  return (message: JournalSqlReaderRequest | JournalSqlReaderCancellation): void => {
    if ('cancel' in message) {
      inFlight.get(message.cancel)?.abort(new Error('journal continuation export cancelled'))
      return
    }
    const { id, operation, cancellable } = message
    const controller = cancellable ? new AbortController() : undefined
    if (controller) {
      inFlight.set(id, controller)
    }
    requests = requests
      .then(() => handle(id, operation, controller?.signal))
      .catch(() => {})
      .finally(() => {
        if (controller) {
          inFlight.delete(id)
        }
      })
  }
}
