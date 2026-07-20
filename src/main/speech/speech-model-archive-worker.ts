import { createReadStream, mkdirSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { x as extractTar } from 'tar'
import unbzip2Stream from 'unbzip2-stream'

// Why: reject links that could redirect extraction outside the model directory.
const ALLOWED_ENTRY_TYPES = new Set(['File', 'OldFile', 'Directory'])

function assertSafeEntry(path: string, type: string): void {
  const normalized = path.replaceAll('\\', '/')
  // Why: validate the path tar writes after strip removes the archive wrapper directory.
  const stripped = normalized.split('/').slice(1).join('/')
  if (
    normalized.includes('\0') ||
    posix.isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    posix.isAbsolute(stripped) ||
    win32.isAbsolute(stripped) ||
    stripped.split('/').includes('..')
  ) {
    throw new Error(`Unsafe speech model archive path: ${path}`)
  }
  if (!ALLOWED_ENTRY_TYPES.has(type)) {
    throw new Error(`Unsupported speech model archive entry type: ${type}`)
  }
}

export async function extractSpeechModelArchive(
  archivePath: string,
  destinationDir: string
): Promise<void> {
  mkdirSync(destinationDir, { recursive: true })
  await pipeline(
    createReadStream(archivePath),
    unbzip2Stream(),
    extractTar({
      cwd: destinationDir,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        assertSafeEntry(path, (entry as { type?: string }).type ?? 'Unsupported')
        return true
      }
    })
  )
}

if (!isMainThread) {
  const port = parentPort
  const { archivePath, destinationDir } = workerData as Record<string, unknown>
  if (!port || typeof archivePath !== 'string' || typeof destinationDir !== 'string') {
    throw new Error('Speech model extraction worker received invalid input.')
  }
  void extractSpeechModelArchive(archivePath, destinationDir).then(
    () => port.postMessage({ ok: true }),
    (error: unknown) =>
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
  )
}
