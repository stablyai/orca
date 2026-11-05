import { watch, type Stats, type FSWatcher } from 'node:fs'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../shared/file-range-read'
import { basename, dirname } from 'node:path'
import { stat, type FileHandle } from 'node:fs/promises'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from '../../../shared/binary-buffer'
import {
  RANGED_FILE_DOCUMENT_MAX_BYTES,
  RangedFileDocumentError,
  type RangedFileDocumentDescriptor
} from '../../../shared/ranged-file-document'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import {
  openLocalRegularFile,
  readLocalFilePrefix,
  fileTooLargeError
} from './local-regular-file-read'

export type Revision = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs' | 'birthtimeMs'>

export function sameRevision(a: Revision, b: Revision): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs
  )
}
export async function openRangedFileDocumentSource(authorize: () => Promise<string>) {
  const path = await authorize()
  const opened = await openLocalRegularFile(path)
  const handle = opened.handle
  try {
    const revision = opened.stats
    if (revision.size > RANGED_FILE_DOCUMENT_MAX_BYTES) {
      throw new RangedFileDocumentError(
        'range_document_too_large',
        fileTooLargeError(revision.size, RANGED_FILE_DOCUMENT_MAX_BYTES).message
      )
    }
    const prefix = await readLocalFilePrefix(handle, Math.min(BINARY_PROBE_BYTES, revision.size))
    if (
      prefix.length !== Math.min(BINARY_PROBE_BYTES, revision.size) ||
      !sameRevision(revision, await handle.stat()) ||
      !sameRevision(revision, await stat(windowsFsPath(path))) ||
      path !== (await authorize())
    ) {
      throw new RangedFileDocumentError('range_document_changed')
    }
    return { path, handle, revision, isBinary: isBinaryBuffer(prefix) }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

export type RangedFileDocumentState = {
  owner: string
  id: string
  version: number
  path: string
  authorize: () => Promise<string>
  handle: FileHandle | null
  revision: Revision
  isBinary: boolean
  valid: boolean
  closed: boolean
  watcher: FSWatcher | null
  requests: Map<string, AbortController>
  pending: Set<Promise<unknown>>
  reloading: boolean
  validation: Promise<void> | null
}

export async function isRangedFileDocumentSourceCurrent(
  source: RangedFileDocumentState,
  handle: FileHandle
): Promise<boolean> {
  try {
    const [path, held, current] = await Promise.all([
      source.authorize(),
      handle.stat(),
      stat(windowsFsPath(source.path))
    ])
    return (
      path === source.path &&
      sameRevision(source.revision, held) &&
      sameRevision(source.revision, current)
    )
  } catch {
    return false
  }
}

export function watchRangedFileDocumentSource(
  path: string,
  changed: () => void,
  failed: () => void
): FSWatcher {
  const fileName = basename(path)
  const watcher = watch(windowsFsPath(dirname(path)), (_event, name) => {
    if (name === null || name.toString() === fileName) {
      changed()
    }
  })
  watcher.on('error', failed)
  watcher.unref()
  return watcher
}

export function rangedFileDocumentDescriptor(
  document: RangedFileDocumentState
): RangedFileDocumentDescriptor {
  return {
    id: document.id,
    version: document.version,
    byteLength: document.revision.size,
    maxReadBytes: MAX_FILE_RANGE_READ_BYTES,
    readOnly: true,
    isBinary: document.isBinary,
    valid: document.valid
  }
}
