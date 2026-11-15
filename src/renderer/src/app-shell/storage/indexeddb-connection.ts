// One cached IndexedDB connection per database, reopened after it closes, fails or is upgraded elsewhere.

export function indexedDbConnection(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void
): () => Promise<IDBDatabase> {
  let opened: Promise<IDBDatabase> | null = null
  return () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, version)
      request.onupgradeneeded = () => upgrade(request.result)
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          // An explicit close fires no close event, so forget the handle here too.
          opened = null
          db.close()
        }
        db.onclose = () => {
          opened = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`${name} database is blocked`))
    }).catch((error: unknown) => {
      opened = null
      throw error
    })
    return opened
  }
}

export function settledRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Resolves once the transaction is on disk; rejects when it aborts (a full disk included). */
export function committedTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}
