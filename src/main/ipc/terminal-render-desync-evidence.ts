import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain } from 'electron'
import type {
  WriteTerminalRenderDesyncEvidenceArgs,
  WriteTerminalRenderDesyncEvidenceResult
} from '../../shared/terminal-render-desync-evidence'
import { isTrustedUIRenderer } from './ui'

const EVIDENCE_DIRECTORY = 'terminal-render-desync-evidence'
const MAX_PNG_DATA_URL_BYTES = 40 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_CAPTURE_DIRECTORIES = 4
const MAX_EVIDENCE_BYTES = 96 * 1024 * 1024
const CAPTURE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
let evidenceWriteQueue = Promise.resolve()

export function registerTerminalRenderDesyncEvidenceHandler(): void {
  ipcMain.handle(
    'terminal:writeRenderDesyncEvidence',
    (event, args: WriteTerminalRenderDesyncEvidenceArgs) => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('Unauthorized render-desync evidence sender')
      }
      const write = evidenceWriteQueue.then(() =>
        writeTerminalRenderDesyncEvidence(app.getPath('userData'), args)
      )
      // Why: serialize retention with writes, but do not let one failed capture
      // poison later diagnostic attempts for the lifetime of the main process.
      evidenceWriteQueue = write.then(
        () => undefined,
        () => undefined
      )
      return write
    }
  )
}

export async function writeTerminalRenderDesyncEvidence(
  userDataPath: string,
  args: WriteTerminalRenderDesyncEvidenceArgs
): Promise<WriteTerminalRenderDesyncEvidenceResult> {
  if (!CAPTURE_ID_PATTERN.test(args.captureId)) {
    throw new Error('Invalid render-desync capture id')
  }
  if (args.phase !== 'corrupt' && args.phase !== 'healed') {
    throw new Error('Invalid render-desync evidence phase')
  }
  if (
    !args.pngDataUrl.startsWith(PNG_DATA_URL_PREFIX) ||
    args.pngDataUrl.length > MAX_PNG_DATA_URL_BYTES
  ) {
    throw new Error('Invalid render-desync PNG payload')
  }

  const png = Buffer.from(args.pngDataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
  const serializedMetadata = args.metadata ? `${JSON.stringify(args.metadata, null, 2)}\n` : null
  if (serializedMetadata && Buffer.byteLength(serializedMetadata, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('Render-desync metadata exceeds the storage budget')
  }
  const evidenceRoot = path.join(userDataPath, EVIDENCE_DIRECTORY)
  const directory = path.join(evidenceRoot, args.captureId)
  const pngPath = path.join(directory, `${args.phase}.png`)
  const metadataPath = args.metadata ? path.join(directory, `${args.phase}.json`) : null

  // Why: captures contain terminal pixels and buffer text, so keep the
  // opt-in field evidence private to the local OS account by default.
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(pngPath, png, { mode: 0o600 })
  if (metadataPath && serializedMetadata) {
    await writeFile(metadataPath, serializedMetadata, {
      encoding: 'utf8',
      mode: 0o600
    })
  }
  await pruneRenderDesyncEvidence(evidenceRoot, directory)
  return { directory, pngPath, metadataPath }
}

async function pruneRenderDesyncEvidence(root: string, currentDirectory: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  const captures = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(root, entry.name)
        const [directoryStat, files] = await Promise.all([
          stat(directory),
          readdir(directory, { withFileTypes: true })
        ])
        const sizes = await Promise.all(
          files.filter((file) => file.isFile()).map((file) => stat(path.join(directory, file.name)))
        )
        return {
          directory,
          bytes: sizes.reduce((total, file) => total + file.size, 0),
          modifiedAt: directoryStat.mtimeMs
        }
      })
  )
  captures.sort((a, b) => a.modifiedAt - b.modifiedAt)
  let totalBytes = captures.reduce((total, capture) => total + capture.bytes, 0)
  while (captures.length > MAX_CAPTURE_DIRECTORIES || totalBytes > MAX_EVIDENCE_BYTES) {
    const removableIndex = captures.findIndex((capture) => capture.directory !== currentDirectory)
    const index = Math.max(removableIndex, 0)
    const [capture] = captures.splice(index, 1)
    await rm(capture.directory, { recursive: true, force: true })
    totalBytes -= capture.bytes
    if (capture.directory === currentDirectory) {
      throw new Error('Render-desync evidence exceeds the aggregate storage budget')
    }
  }
}
