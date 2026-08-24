import type { Dir } from 'node:fs'
import { open, opendir, type FileHandle } from 'node:fs/promises'

const CLI_LOG_LIMIT = 12
const LOG_SECTION_LIMIT_BYTES = 128 * 1024
const LOG_READ_LIMIT_BYTES = LOG_SECTION_LIMIT_BYTES * 2

/** Races filesystem work because Node's promise APIs do not accept AbortSignal. */
function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

/** Disposes a resource that finishes opening after cancellation wins the race. */
async function acquireWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  dispose: (resource: T) => Promise<void>
): Promise<T> {
  try {
    return await awaitWithAbort(operation, signal)
  } catch (error) {
    if (signal.aborted) {
      void operation.then(dispose).catch(() => undefined)
    }
    throw error
  }
}

/** Closes resources without letting a stuck close extend the fetch deadline. */
async function closeWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return
  }
  await awaitWithAbort(operation, signal)
}

/** Keeps only the newest bounded set while streaming an arbitrarily large directory. */
function retainNewestLogName(logNames: string[], candidate: string): void {
  const insertionIndex = logNames.findIndex((name) => candidate.localeCompare(name) > 0)
  if (insertionIndex === -1) {
    if (logNames.length < CLI_LOG_LIMIT) {
      logNames.push(candidate)
    }
    return
  }
  logNames.splice(insertionIndex, 0, candidate)
  if (logNames.length > CLI_LOG_LIMIT) {
    logNames.pop()
  }
}

/** Streams CLI log names so directory size cannot dictate peak memory use. */
export async function findNewestAntigravityCliLogNames(
  logDirectory: string,
  signal: AbortSignal
): Promise<string[]> {
  const openDirectory = opendir(logDirectory)
  const directory = await acquireWithAbort(openDirectory, signal, (resource: Dir) =>
    resource.close()
  )
  const logNames: string[] = []
  try {
    while (true) {
      const entry = await awaitWithAbort(directory.read(), signal)
      if (!entry) {
        break
      }
      if (entry.isFile() && /^cli-.*\.log$/i.test(entry.name)) {
        retainNewestLogName(logNames, entry.name)
      }
    }
    return logNames
  } finally {
    await closeWithAbort(directory.close(), signal)
  }
}

/** Fills a bounded section despite short filesystem reads. */
async function readLogSection(
  handle: FileHandle,
  position: number,
  byteLength: number,
  signal: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(byteLength)
  let totalBytesRead = 0
  while (totalBytesRead < byteLength) {
    const { bytesRead } = await awaitWithAbort(
      handle.read(buffer, totalBytesRead, byteLength - totalBytesRead, position + totalBytesRead),
      signal
    )
    if (bytesRead === 0) {
      break
    }
    totalBytesRead += bytesRead
  }
  // Why: cancellation can land after the final read resolves but before its caller parses the log.
  signal.throwIfAborted()
  return buffer.subarray(0, totalBytesRead)
}

/** Reads bounded head and tail sections because listener announcements occur at startup. */
export async function readAntigravityLogExcerpt(
  filePath: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const openFile = open(filePath, 'r')
  const handle = await acquireWithAbort(openFile, signal, (resource: FileHandle) =>
    resource.close()
  )
  try {
    const stats = await awaitWithAbort(handle.stat(), signal)
    if (!stats.isFile()) {
      throw new Error('Antigravity log target is not a file')
    }
    if (stats.size === 0) {
      return ''
    }
    if (stats.size <= LOG_READ_LIMIT_BYTES) {
      return (await readLogSection(handle, 0, stats.size, signal)).toString('utf8')
    }
    const head = await readLogSection(handle, 0, LOG_SECTION_LIMIT_BYTES, signal)
    const tail = await readLogSection(
      handle,
      stats.size - LOG_SECTION_LIMIT_BYTES,
      LOG_SECTION_LIMIT_BYTES,
      signal
    )
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`
  } finally {
    await closeWithAbort(handle.close(), signal)
  }
}
