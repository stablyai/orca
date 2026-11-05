import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import { stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from '../../../shared/binary-buffer'
import {
  MAX_FILE_RANGE_READ_BYTES,
  validateFileRangeRequest
} from '../../../shared/file-range-read'
import {
  RANGED_FILE_DOCUMENT_MAX_BYTES,
  RangedFileDocumentError,
  type RangedFileDocumentChunk,
  type RangedFileDocumentDescriptor,
  type RangedFileDocumentRead
} from '../../../shared/ranged-file-document'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import {
  openLocalRegularFile,
  readLocalFilePrefix,
  fileTooLargeError
} from './local-regular-file-read'

type Revision = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs' | 'birthtimeMs'>
type Document = {
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

function sameRevision(a: Revision, b: Revision): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs
  )
}
// Issued native reads retain their permits even after their transport stops waiting.
let activeNativeReads = 0

function cancelled(): Error {
  return new RangedFileDocumentError('range_document_cancelled')
}

/** Handles belong to the authenticated reader; payloads never outlive a validated revision. */
export class RangedFileDocuments {
  private readonly documents = new Map<string, Document>()
  private opening = 0
  private readonly openingByOwner = new Map<string, number>()
  private readonly closedOwners = new Set<string>()

  async open(
    owner: string,
    authorize: () => Promise<string>,
    signal?: AbortSignal
  ): Promise<RangedFileDocumentDescriptor> {
    return this.openReserved(owner, authorize, signal)
  }

  private async openReserved(
    owner: string,
    authorize: () => Promise<string>,
    signal?: AbortSignal,
    reservation?: Document
  ): Promise<RangedFileDocumentDescriptor> {
    const mine = [...this.documents.values()].filter((document) => document.owner === owner).length
    if (
      mine + (this.openingByOwner.get(owner) ?? 0) - (reservation ? 1 : 0) >= 8 ||
      this.documents.size + this.opening - (reservation ? 1 : 0) >= 64
    ) {
      throw new RangedFileDocumentError('range_document_busy')
    }
    if (signal?.aborted || this.closedOwners.has(owner) || reservation?.closed) throw cancelled()
    this.opening += 1
    this.openingByOwner.set(owner, (this.openingByOwner.get(owner) ?? 0) + 1)
    let handle: FileHandle | null = null
    try {
      const path = await authorize()
      const opened = await openLocalRegularFile(path)
      handle = opened.handle
      const revision = opened.stats
      if (revision.size > RANGED_FILE_DOCUMENT_MAX_BYTES)
        throw new RangedFileDocumentError(
          'range_document_too_large',
          fileTooLargeError(revision.size, RANGED_FILE_DOCUMENT_MAX_BYTES).message
        )
      const prefix = await readLocalFilePrefix(handle, Math.min(BINARY_PROBE_BYTES, revision.size))
      if (
        prefix.length !== Math.min(BINARY_PROBE_BYTES, revision.size) ||
        !sameRevision(revision, await handle.stat()) ||
        !sameRevision(revision, await stat(windowsFsPath(path))) ||
        path !== (await authorize())
      ) {
        throw new RangedFileDocumentError('range_document_changed')
      }
      if (signal?.aborted || this.closedOwners.has(owner) || reservation?.closed) throw cancelled()
      const document: Document = {
        owner,
        id: randomUUID(),
        version: 1,
        path,
        authorize,
        handle,
        revision,
        isBinary: isBinaryBuffer(prefix),
        valid: true,
        closed: false,
        watcher: null,
        requests: new Map(),
        pending: new Set(),
        reloading: false,
        validation: null
      }
      this.installWatcher(document)
      this.documents.set(document.id, document)
      handle = null
      return this.descriptor(document)
    } finally {
      await handle?.close().catch(() => {})
      this.opening -= 1
      const count = (this.openingByOwner.get(owner) ?? 1) - 1
      if (count) this.openingByOwner.set(owner, count)
      else {
        this.openingByOwner.delete(owner)
        this.closedOwners.delete(owner)
      }
    }
  }

  async read(
    owner: string,
    params: RangedFileDocumentRead,
    signal?: AbortSignal
  ): Promise<RangedFileDocumentChunk> {
    try {
      validateFileRangeRequest(params.offset, params.length)
    } catch {
      throw new RangedFileDocumentError('range_document_invalid_range')
    }
    const document = this.require(owner, params.id)
    if (
      !Number.isSafeInteger(params.version) ||
      params.version !== document.version ||
      !document.valid ||
      document.reloading
    )
      throw new RangedFileDocumentError('range_document_stale')
    if (params.offset > document.revision.size)
      throw new RangedFileDocumentError('range_document_invalid_range')
    if (
      typeof params.requestToken !== 'string' ||
      !params.requestToken ||
      params.requestToken.length > 128
    )
      throw new RangedFileDocumentError('range_document_invalid_request')
    if (
      document.requests.size >= 2 ||
      activeNativeReads >= 2 ||
      document.requests.has(params.requestToken)
    )
      throw new RangedFileDocumentError('range_document_busy')
    if (signal?.aborted) throw cancelled()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    document.requests.set(params.requestToken, controller)
    activeNativeReads += 1
    const attempt = this.readDocument(document, params, controller.signal)
    document.pending.add(attempt)
    try {
      return await attempt
    } finally {
      signal?.removeEventListener('abort', abort)
      document.requests.delete(params.requestToken)
      document.pending.delete(attempt)
      activeNativeReads -= 1
    }
  }

  private async readDocument(
    document: Document,
    params: RangedFileDocumentRead,
    signal: AbortSignal
  ): Promise<RangedFileDocumentChunk> {
    await this.validate(document)
    if (signal.aborted || !document.valid) throw cancelled()
    const handle = document.handle!
    const buffer = Buffer.alloc(Math.min(params.length, document.revision.size - params.offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, params.offset)
    if (bytesRead !== buffer.length) this.invalidate(document)
    await this.validate(document, true)
    if (signal.aborted || !document.valid || params.version !== document.version) throw cancelled()
    return {
      version: params.version,
      contentBase64: buffer.toString('base64'),
      bytesRead,
      eof: params.offset + bytesRead === document.revision.size
    }
  }

  cancel(owner: string, id: string, requestToken: string): void {
    this.require(owner, id).requests.get(requestToken)?.abort()
  }

  async status(owner: string, id: string): Promise<RangedFileDocumentDescriptor> {
    const document = this.require(owner, id)
    if (document.valid) await this.validate(document)
    return this.descriptor(document)
  }

  async reload(
    owner: string,
    id: string,
    signal?: AbortSignal
  ): Promise<RangedFileDocumentDescriptor> {
    const previous = this.require(owner, id)
    if (previous.reloading) throw new RangedFileDocumentError('range_document_busy')
    previous.reloading = true
    this.invalidate(previous)
    try {
      await Promise.allSettled([...previous.pending])
      await previous.handle?.close().catch(() => {})
      previous.handle = null
      if (previous.closed) throw cancelled()
      const next = await this.openReserved(owner, previous.authorize, signal, previous)
      const replacement = this.require(owner, next.id)
      if (previous.closed || signal?.aborted) {
        await this.close(owner, next.id)
        throw cancelled()
      }
      this.documents.delete(next.id)
      replacement.id = id
      replacement.version = previous.version + 1
      this.documents.set(id, replacement)
      return this.descriptor(replacement)
    } catch (error) {
      if (!previous.closed && !this.closedOwners.has(owner)) this.documents.set(id, previous)
      throw error
    } finally {
      previous.reloading = false
    }
  }

  async close(owner: string, id: string): Promise<void> {
    const document = this.require(owner, id)
    document.closed = true
    this.invalidate(document)
    await Promise.allSettled([...document.pending])
    await document.handle?.close().catch(() => {})
    document.handle = null
    if (this.documents.get(id) === document) this.documents.delete(id)
  }

  async closeOwner(owner: string): Promise<void> {
    this.closedOwners.add(owner)
    await Promise.allSettled(
      [...this.documents.values()]
        .filter((document) => document.owner === owner && !document.closed)
        .map((document) => this.close(owner, document.id))
    )
    if (!this.openingByOwner.has(owner)) this.closedOwners.delete(owner)
  }

  private require(owner: string, id: string): Document {
    const document = this.documents.get(id)
    if (!document || document.owner !== owner || document.closed)
      throw new RangedFileDocumentError('range_document_unknown')
    return document
  }

  private descriptor(document: Document): RangedFileDocumentDescriptor {
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

  private invalidate(document: Document): void {
    if (document.valid) {
      document.valid = false
      document.version += 1
    }
    document.watcher?.close()
    document.watcher = null
    for (const controller of document.requests.values()) controller.abort()
  }

  private async validate(document: Document, fresh = false): Promise<void> {
    if (fresh && document.validation) await document.validation
    if (!document.valid || !document.handle) return
    if (document.validation) return document.validation
    const operation = this.validateRevision(document)
    document.validation = operation
    try {
      await operation
    } finally {
      if (document.validation === operation) document.validation = null
    }
  }

  private async validateRevision(document: Document): Promise<void> {
    const handle = document.handle
    if (!document.valid || !handle) return
    try {
      const [path, held, current] = await Promise.all([
        document.authorize(),
        handle.stat(),
        stat(windowsFsPath(document.path))
      ])
      if (
        path !== document.path ||
        !sameRevision(document.revision, held) ||
        !sameRevision(document.revision, current)
      )
        this.invalidate(document)
    } catch {
      this.invalidate(document)
    }
  }

  private installWatcher(document: Document): void {
    const fileName = basename(document.path)
    document.watcher = watch(windowsFsPath(dirname(document.path)), (_event, name) => {
      if (name === null || name.toString() === fileName) void this.validate(document)
    })
    document.watcher.on('error', () => this.invalidate(document))
    document.watcher.unref()
  }
}
