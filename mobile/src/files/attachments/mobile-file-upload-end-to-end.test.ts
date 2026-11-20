import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as z from 'zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The picker module imports Expo natives that cannot load in Node; every device call is injected below.
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system', () => ({ File: class {} }))
import { AgentSessionAttachmentStore } from '@orca/test-host/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  AttachmentUploadAppendParams,
  AttachmentUploadIdParams,
  AttachmentUploadStartParams
} from '../../../../src/shared/rpc-contract/structured-agent-session/agent-session-attachment-params'
import { MediaHandleRegistry } from '../../mobile-web-shell/native-capabilities/media-handle-registry'
import {
  mediaNameResultSchema,
  mediaPickResultSchema,
  mediaReadResultSchema,
  mediaReleaseResultSchema
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import { streamStagedMediaBase64 } from '../../mobile-web-shell/bridge/native-capabilities/staged-media-bytes'
import {
  createNativeMediaVerbServer,
  type NativeMediaFile
} from '../../platform/media-picking/native-media'
import {
  MobileUploadCancelledError,
  type PickedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import { uploadMobileAgentSessionAttachment } from './mobile-agent-session-attachment-upload'
import { uploadMobileTerminalFile } from './mobile-terminal-file-upload'
import { uploadMobileNativeChatImages } from '../../session/native-chat/composer/attachments/mobile-native-chat-image-attachment'
import { pickMobileFiles, type StreamedFile } from './mobile-file-source-picker'

// Real files on disk go through the phone's streaming code, the host's param schemas and attachment store, and come back byte for byte.

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let root: string
let store: AgentSessionAttachmentStore
const callerKey = 'phone'

// A 5 MiB file with a tail that is neither a chunk nor a 3-byte multiple would corrupt on any chunk-seam or padding bug.
const FILES = new Map<string, Buffer>([
  ['movie.mov', randomBytes(5 * 1024 * 1024 + 7)],
  ['notes.txt', Buffer.from('plain text from the Files app\n')],
  ['empty.bin', Buffer.alloc(0)],
  ['blob.bin', randomBytes(384 * 1024)]
])

function fileBytes(name: string): Buffer {
  const bytes = FILES.get(name)
  if (!bytes) {
    throw new Error(`unknown fixture ${name}`)
  }
  return bytes
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-phone-upload-'))
  store = new AgentSessionAttachmentStore(join(root, 'store'), {
    hasSession: (id) => id === 'session-1'
  })
  for (const [name, bytes] of FILES) {
    writeFileSync(join(root, name), bytes)
  }
})

afterAll(() => {
  store.clearInFlightForTests()
  rmSync(root, { recursive: true, force: true })
})

// Route phone RPCs through the host's own param schemas into the real store, as the RPC server does.
function hostClient(): UnvalidatedRpcRequestPort {
  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    'agentSessionAttachment.uploadStart': async (params) =>
      store.startUpload({ callerKey, ...AttachmentUploadStartParams.parse(params) }),
    'agentSessionAttachment.uploadAppend': async (params) =>
      store.appendChunk({ callerKey, ...AttachmentUploadAppendParams.parse(params) }),
    'agentSessionAttachment.uploadCommit': async (params) =>
      store.commitUpload({ callerKey, uploadId: AttachmentUploadIdParams.parse(params).uploadId }),
    'agentSessionAttachment.uploadAbort': async (params) =>
      store.abortUpload({ callerKey, uploadId: AttachmentUploadIdParams.parse(params).uploadId })
  }
  return {
    sendRequest: async (method: string, params?: unknown) => {
      try {
        const handler = handlers[method]
        if (!handler) {
          throw new Error(`no handler for ${method}`)
        }
        return { id: 'r', ok: true, result: await handler(params) }
      } catch (error) {
        return {
          id: 'r',
          ok: false,
          error: { code: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
      }
    }
  }
}

async function uploadPicked(client: UnvalidatedRpcRequestPort, file: PickedMobileFile) {
  return uploadMobileAgentSessionAttachment(client, {
    sessionId: 'session-1',
    name: file.name,
    byteLength: file.byteLength,
    chunks: file.chunks()
  }).finally(() => file.dispose?.())
}

function nodeFile(path: string): StreamedFile & NativeMediaFile {
  return {
    get size() {
      return statSync(path).size
    },
    open: () => {
      const fd = openSync(path, 'r')
      let cursor = 0
      return {
        get offset() {
          return cursor
        },
        set offset(next: number | null) {
          cursor = next ?? 0
        },
        readBytesSync: (length: number) => {
          const buffer = new Uint8Array(length)
          const read = readSync(fd, buffer, 0, length, cursor)
          cursor += read
          return buffer.subarray(0, read)
        },
        close: () => closeSync(fd)
      }
    },
    delete: () => unlinkSync(path)
  }
}

describe('phone file upload end to end', () => {
  it('native: streams every picked file into the host store byte for byte and clears the cache copies', async () => {
    const copies = [...FILES.keys()].map((name) => {
      const copy = join(root, `cache-${name}`)
      writeFileSync(copy, fileBytes(name))
      return { name, copy }
    })
    const client = hostClient()
    const stored: { name: string; path: string; byteLength: number }[] = []
    for await (const file of pickMobileFiles({
      launch: async () => ({
        canceled: false,
        assets: copies.map(({ name, copy }) => ({
          uri: copy,
          name,
          size: fileBytes(name).byteLength,
          mimeType: 'application/octet-stream',
          lastModified: 0
        }))
      }),
      createFile: nodeFile
    })) {
      stored.push(await uploadPicked(client, file))
    }
    expect(stored.map((file) => file.name)).toEqual([...FILES.keys()])
    for (const file of stored) {
      const original = fileBytes(file.name)
      expect(file.byteLength).toBe(original.byteLength)
      expect(sha256(readFileSync(file.path))).toBe(sha256(original))
    }
    expect(copies.some(({ copy }) => existsSync(copy))).toBe(false)
  })

  it('native: leaves no cache copies behind when the consumer stops after the first file', async () => {
    const copies = ['a.bin', 'b.bin'].map((name) => {
      const copy = join(root, `early-${name}`)
      writeFileSync(copy, fileBytes('notes.txt'))
      return { name, copy }
    })
    for await (const file of pickMobileFiles({
      launch: async () => ({
        canceled: false,
        assets: copies.map(({ name, copy }) => ({
          uri: copy,
          name,
          size: 30,
          mimeType: 'text/plain',
          lastModified: 0
        }))
      }),
      createFile: nodeFile
    })) {
      expect(file.byteLength).toBe(30)
      break
    }
    expect(copies.some(({ copy }) => existsSync(copy))).toBe(false)
  })

  it('web shell: streams files through the bridge verbs into the host store byte for byte', async () => {
    const uris = new Map<string, string>()
    const registry = new MediaHandleRegistry({
      now: () => 1_000,
      discard: (uri) => {
        unlinkSync(uris.get(uri) ?? uri)
        uris.delete(uri)
      }
    })
    const serve = createNativeMediaVerbServer({
      registry,
      launchLibrary: async () => ({ canceled: true }),
      launchFiles: async () => ({
        canceled: false,
        assets: [...FILES].map(([name, bytes]) => {
          const copy = join(root, `shell-${name}`)
          writeFileSync(copy, bytes)
          uris.set(copy, copy)
          return { uri: copy, name, mimeType: 'application/octet-stream' }
        })
      }),
      launchGallery: async () => ({ canceled: true }),
      readClipboardImage: async () => null,
      stageBase64: () => {
        throw new Error('unused')
      },
      openFile: nodeFile,
      ownsStagedUri: (uri) => uris.has(uri),
      copyIntoCache: (uri) => uri,
      discard: (uri) => unlinkSync(uri)
    })
    const verbs = {
      canNameMedia: true,
      pickMedia: async (source: string, multiple: boolean) =>
        mediaPickResultSchema.parse(await serve('native.media.pick', { source, multiple })).items,
      readMedia: async (handle: string, offset: number, length: number) =>
        mediaReadResultSchema.parse(await serve('native.media.read', { handle, offset, length })),
      releaseMedia: async (handle: string) =>
        mediaReleaseResultSchema.parse(await serve('native.media.release', { handle })).released,
      nameMedia: async (handle: string) =>
        mediaNameResultSchema.parse(await serve('native.media.name', { handle })).name
    }

    const client = hostClient()
    const items = await verbs.pickMedia('files', true)
    expect(items).toHaveLength([...FILES.keys()].length)
    for (const item of items) {
      const name = await verbs.nameMedia(item.handle)
      if (name === null) {
        throw new Error('the shell did not name a picked file')
      }
      const file: PickedMobileFile = {
        name,
        mime: item.mime,
        byteLength: item.byteLength,
        chunks: () => streamStagedMediaBase64(verbs, item)
      }
      const result = await uploadPicked(client, file)
      expect(sha256(readFileSync(result.path))).toBe(sha256(fileBytes(name)))
      await verbs.releaseMedia(item.handle)
    }
    expect(registry.liveCount()).toBe(0)
  })

  it('web shell: stages a Files pick over the image cap but still refuses an oversized library image', async () => {
    const hundredMiB = 100 * 1024 * 1024
    const registry = new MediaHandleRegistry({ now: () => 1_000, discard: () => {} })
    const huge: NativeMediaFile = {
      size: hundredMiB,
      open: () => nodeFile(join(root, 'blob.bin')).open()
    }
    const serve = createNativeMediaVerbServer({
      registry,
      launchLibrary: async () => ({
        canceled: false,
        assets: [{ uri: 'file:///cache/huge.jpg', mimeType: 'image/jpeg' }]
      }),
      launchFiles: async () => ({
        canceled: false,
        assets: [{ uri: 'file:///cache/huge.mov', mimeType: 'video/quicktime' }]
      }),
      launchGallery: async () => ({ canceled: true }),
      readClipboardImage: async () => null,
      stageBase64: () => 'unused',
      openFile: () => huge,
      ownsStagedUri: () => true,
      copyIntoCache: (uri) => uri,
      discard: () => {}
    })
    const files = mediaPickResultSchema.parse(
      await serve('native.media.pick', { source: 'files', multiple: false })
    )
    expect(files.items[0]?.byteLength).toBe(hundredMiB)
    await expect(
      serve('native.media.pick', { source: 'library', multiple: false })
    ).rejects.toMatchObject({
      code: 'native_media_too_large'
    })
  })

  it('terminal: streams a large file to a local host with no chat session, byte for byte', async () => {
    const copy = join(root, 'cache-terminal.mov')
    writeFileSync(copy, fileBytes('movie.mov'))
    for await (const file of pickMobileFiles({
      launch: async () => ({
        canceled: false,
        assets: [
          {
            uri: copy,
            name: 'terminal.mov',
            size: fileBytes('movie.mov').byteLength,
            mimeType: 'video/quicktime',
            lastModified: 0
          }
        ]
      }),
      createFile: nodeFile
    })) {
      const path = await uploadMobileTerminalFile(hostClient(), file, { connectionId: null })
      expect(sha256(readFileSync(path))).toBe(sha256(fileBytes('movie.mov')))
    }
  })

  it('terminal: refuses a file over the clipboard limit for a remote terminal instead of copying it here', async () => {
    const big = {
      name: 'remote.mov',
      mime: 'video/quicktime',
      byteLength: 100 * 1024 * 1024,
      chunks: async function* () {
        yield ''
      }
    }
    await expect(
      uploadMobileTerminalFile(hostClient(), big, { connectionId: 'ssh-1' })
    ).rejects.toThrow('over')
  })

  it('chat image: a pasted screenshot lands in the store, where the host can read it back for the phone', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const [uploaded] = await uploadMobileNativeChatImages('library', {
      client: hostClient(),
      getConnectionId: async () => null,
      pickImages: () => [{ base64: png, mime: 'image/png' }]
    })
    expect(uploaded?.path.startsWith(join(root, 'store'))).toBe(true)
    expect(await store.readPreview(uploaded?.path ?? '')).toMatchObject({
      isImage: true,
      mimeType: 'image/png'
    })
  })

  it('host: refuses an upload over 500 MB at start and accepts one just under it', async () => {
    const client = hostClient()
    const start = (byteLength: number) =>
      client.sendRequest('agentSessionAttachment.uploadStart', {
        sessionId: 'session-1',
        name: 'big.mov',
        byteLength
      })
    expect(await start(500 * 1024 * 1024 + 1)).toMatchObject({ ok: false })
    const accepted = await start(500 * 1024 * 1024)
    expect(accepted).toMatchObject({ ok: true })
    await client.sendRequest('agentSessionAttachment.uploadAbort', {
      uploadId: z.object({ uploadId: z.string() }).parse(accepted.ok ? accepted.result : null)
        .uploadId
    })
  })

  it('stops a cancelled upload between chunks and leaves no partial file on the host', async () => {
    const path = join(root, 'cancel-me.bin')
    writeFileSync(path, fileBytes('movie.mov'))
    let chunksSent = 0
    for await (const file of pickMobileFiles({
      launch: async () => ({
        canceled: false,
        assets: [
          {
            uri: path,
            name: 'cancel-me.bin',
            size: fileBytes('movie.mov').byteLength,
            mimeType: 'application/octet-stream',
            lastModified: 0
          }
        ]
      }),
      createFile: nodeFile
    })) {
      await expect(
        uploadMobileAgentSessionAttachment(hostClient(), {
          sessionId: 'session-1',
          name: file.name,
          byteLength: file.byteLength,
          chunks: file.chunks(),
          onProgress: () => {
            chunksSent += 1
          },
          shouldCancel: () => chunksSent >= 1
        }).finally(() => file.dispose?.())
      ).rejects.toBeInstanceOf(MobileUploadCancelledError)
    }
    expect(chunksSent).toBe(1)
    const stored = readdirSync(join(root, 'store'), { recursive: true }).map(String)
    expect(stored.some((entry) => entry.includes('cancel-me.bin'))).toBe(false)
  })

  it('reports a request that fails because the upload was cancelled as a cancel, not a failure', async () => {
    let cancelled = false
    const methods: string[] = []
    const client: UnvalidatedRpcRequestPort = {
      sendRequest: async (method: string) => {
        methods.push(method)
        if (method === 'agentSessionAttachment.uploadAppend') {
          cancelled = true
          return { id: 'r', ok: false, error: { code: 'failed', message: 'connection lost' } }
        }
        return { id: 'r', ok: true, result: { uploadId: 'upload-1', aborted: true } }
      }
    }
    await expect(
      uploadMobileAgentSessionAttachment(client, {
        sessionId: 'session-1',
        name: 'clip.mov',
        byteLength: 3,
        chunks: (async function* () {
          yield 'AAAA'
        })(),
        shouldCancel: () => cancelled
      })
    ).rejects.toBeInstanceOf(MobileUploadCancelledError)
    expect(methods.at(-1)).toBe('agentSessionAttachment.uploadAbort')
  })
})
