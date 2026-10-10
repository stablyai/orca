import { EventEmitter, once } from 'node:events'
import { createServer, type Server, type RequestListener } from 'node:http'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewChatAddress, registerChatAddressPreviewHandlers } from './chat-address-preview'
import { handleChatAddressPreviewRequest } from './chat-address-preview-protocol'
import {
  createChatPreviewGrant,
  getChatPreviewGrant,
  isAllowedChatPreviewRequest,
  releaseOwnedChatPreview
} from './chat-address-preview-grants'
import { CHAT_PREVIEW_MAX_TEXT_BYTES } from './chat-address-preview-content'
import type { ChatAddressPreviewResult } from '../../shared/chat-address-preview'
import type { Store } from '../persistence'

const { authorize, ipcHandle } = vi.hoisted(() => ({
  authorize: vi.fn(async (path: string) => path),
  ipcHandle: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
  protocol: { handle: vi.fn() },
  session: { defaultSession: { resolveProxy: async () => 'DIRECT' } }
}))
vi.mock('../ipc/local-file-access-resolution', () => ({ resolveLocalFileRequestPath: authorize }))

function owner(id: number) {
  const events = new EventEmitter()
  const frame = {}
  const sender = Object.assign(events, {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///app/index.html'
  }) as unknown as WebContents
  return { sender, senderFrame: frame } as IpcMainInvokeEvent
}

const store = {} as Store
let directory: string
let sender: IpcMainInvokeEvent
let servers: Server[]
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

beforeEach(async () => {
  vi.clearAllMocks()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-address-preview-')))
  sender = owner(700)
  servers = []
})

afterEach(async () => {
  sender.sender.emit('destroyed')
  for (const server of servers) {
    server.closeAllConnections()
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  await rm(directory, { recursive: true, force: true })
})

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture server address')
  }
  return `http://127.0.0.1:${address.port}/extensionless`
}

function readyUrl(result: ChatAddressPreviewResult): string {
  if (result.status !== 'ready' || !result.url) {
    throw new Error(`Expected preview URL: ${JSON.stringify(result)}`)
  }
  return result.url
}

describe('desktop address preview resources', () => {
  it('reads named local UTF-8 and Markdown without workspace or remote routing', async () => {
    const filePath = join(directory, 'notes with spaces.md')
    await writeFile(filePath, '# Hello\nA local document.')
    expect(
      await previewChatAddress(sender, { id: 'notes', source: filePath }, store)
    ).toMatchObject({
      status: 'ready',
      kind: 'markdown',
      content: '# Hello\nA local document.'
    })
    expect(authorize).toHaveBeenCalledWith(filePath, { kind: 'user-file' }, store)
  })

  it('returns image bytes through a grant and revokes the URL on release', async () => {
    const path = join(directory, 'photo')
    await writeFile(path, png)
    const result = await previewChatAddress(sender, { id: 'image', source: path }, store)
    const url = readyUrl(result)
    const response = await handleChatAddressPreviewRequest(new Request(url, { referrer: '' }))
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
    releaseOwnedChatPreview(sender.sender.id, 'image')
    expect((await handleChatAddressPreviewRequest(new Request(url))).status).toBe(404)
  })

  it('returns bounded PDF base64 and inert HTML text, not executable document URLs', async () => {
    const pdfPath = join(directory, 'document')
    await writeFile(pdfPath, '%PDF-1.7\nfixture')
    expect(await previewChatAddress(sender, { id: 'pdf', source: pdfPath }, store)).toMatchObject({
      status: 'ready',
      kind: 'pdf',
      content: Buffer.from('%PDF-1.7\nfixture').toString('base64')
    })
    const htmlPath = join(directory, 'index.html')
    await writeFile(htmlPath, '<script>fetch("http://private/")</script>')
    const result = await previewChatAddress(sender, { id: 'html', source: htmlPath }, store)
    expect(result).toMatchObject({ status: 'ready', kind: 'text' })
    expect(result).not.toHaveProperty('url')
  })

  it('does not fully read unknown binary files, and refuses oversized documents and image dimensions', async () => {
    const binary = join(directory, 'archive.bin')
    await writeFile(binary, Buffer.alloc(CHAT_PREVIEW_MAX_TEXT_BYTES + 1))
    expect(await previewChatAddress(sender, { id: 'binary', source: binary }, store)).toMatchObject(
      { status: 'ready', kind: 'file' }
    )
    const text = join(directory, 'large.txt')
    await writeFile(text, Buffer.alloc(CHAT_PREVIEW_MAX_TEXT_BYTES + 1, 65))
    expect(await previewChatAddress(sender, { id: 'text', source: text }, store)).toMatchObject({
      status: 'error',
      message: 'Preview file exceeds the size limit'
    })
    const huge = Buffer.from(png)
    huge.writeUInt32BE(100_000, 16)
    const image = join(directory, 'huge.png')
    await writeFile(image, huge)
    expect(await previewChatAddress(sender, { id: 'huge', source: image }, store)).toMatchObject({
      status: 'error',
      message: 'Image dimensions exceed the preview safety limit'
    })
  })

  it('refuses directories, network shares and untrusted or child-frame IPC callers', async () => {
    expect(
      await previewChatAddress(sender, { id: 'directory', source: directory }, store)
    ).toMatchObject({ status: 'error' })
    authorize.mockClear()
    expect(
      await previewChatAddress(sender, { id: 'share', source: '//host/share/file' }, store)
    ).toMatchObject({ status: 'error' })
    expect(authorize).not.toHaveBeenCalled()
    const untrusted = {
      ...sender,
      sender: { ...sender.sender, isDestroyed: () => false, getType: () => 'webview' }
    } as IpcMainInvokeEvent
    expect(
      await previewChatAddress(untrusted, { id: 'untrusted', source: directory }, store)
    ).toMatchObject({ status: 'error' })
    expect(
      await previewChatAddress(
        { ...sender, senderFrame: {} } as IpcMainInvokeEvent,
        { id: 'frame', source: directory },
        store
      )
    ).toMatchObject({ status: 'error' })
  })

  it('authorizes the real requesting owner and refuses navigation/script/origin consumers', async () => {
    const path = join(directory, 'photo.png')
    await writeFile(path, png)
    const url = readyUrl(await previewChatAddress(sender, { id: 'image', source: path }, store))
    expect(
      isAllowedChatPreviewRequest({ url, webContentsId: sender.sender.id, resourceType: 'image' })
    ).toBe(true)
    expect(isAllowedChatPreviewRequest({ url, webContentsId: 701, resourceType: 'image' })).toBe(
      false
    )
    expect(
      isAllowedChatPreviewRequest({
        url,
        webContentsId: sender.sender.id,
        resourceType: 'mainFrame'
      })
    ).toBe(false)
    expect(
      isAllowedChatPreviewRequest({ url, webContentsId: sender.sender.id, resourceType: 'script' })
    ).toBe(false)
    expect(
      (
        await handleChatAddressPreviewRequest(
          new Request(url, { headers: { Origin: 'https://attacker.example' } })
        )
      ).status
    ).toBe(403)
    releaseOwnedChatPreview(701, 'image')
    expect(getChatPreviewGrant(url)).toBeDefined()
    sender.sender.emit('render-process-gone')
    expect(getChatPreviewGrant(url)).toBeUndefined()
  })

  it('bounds live grants and detaches owner listeners after release', () => {
    for (let index = 0; index < 8; index++) {
      createChatPreviewGrant(sender.sender, `id-${index}`)
    }
    expect(() => createChatPreviewGrant(sender.sender, 'overflow')).toThrow('count limit')
    for (let index = 0; index < 8; index++) {
      releaseOwnedChatPreview(sender.sender.id, `id-${index}`)
    }
    expect(sender.sender.listenerCount('destroyed')).toBe(0)
    expect(sender.sender.listenerCount('did-navigate')).toBe(0)
  })

  it('requires explicit consent before even requesting a private HTTP endpoint', async () => {
    let count = 0
    const source = await serve((_request, response) => {
      count++
      response.setHeader('Content-Type', 'image/png')
      response.end(png)
    })
    expect(await previewChatAddress(sender, { id: 'remote', source }, store)).toMatchObject({
      status: 'permission-required'
    })
    expect(count).toBe(0)
    const result = await previewChatAddress(
      sender,
      { id: 'remote', source, allowPrivateNetwork: true },
      store
    )
    expect(result).toMatchObject({ status: 'ready', kind: 'image' })
    expect(count).toBe(2)
    const bytes = await (
      await handleChatAddressPreviewRequest(new Request(readyUrl(result), { referrer: '' }))
    ).arrayBuffer()
    expect(Buffer.from(bytes)).toEqual(png)
  })

  it('supports seekable local and HTTP media without buffering the whole recording', async () => {
    const wav = Buffer.alloc(256)
    wav.write('RIFF', 0)
    wav.write('WAVE', 8)
    const file = join(directory, 'recording.wav')
    await writeFile(file, wav)
    const source = await serve((request, response) => {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      if (match) {
        const start = Number(match[1])
        const end = Math.min(Number(match[2] || wav.length - 1), wav.length - 1)
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${wav.length}`,
          'Content-Type': 'audio/wav'
        })
        response.end(wav.subarray(start, end + 1))
      } else {
        response.setHeader('Content-Type', 'audio/wav')
        response.end(wav)
      }
    })
    for (const [id, address] of [
      ['local', file],
      ['network', source]
    ]) {
      const url = readyUrl(
        await previewChatAddress(sender, { id, source: address, allowPrivateNetwork: true }, store)
      )
      const response = await handleChatAddressPreviewRequest(
        new Request(url, { referrer: '', headers: { Range: 'bytes=44-63' } })
      )
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe('bytes 44-63/256')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(wav.subarray(44, 64))
    }
  })

  it('cancels a pending HTTP read on release and never publishes a late grant', async () => {
    const received = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const source = await serve((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('waiting')
      request.once('close', disconnected.resolve)
      received.resolve()
    })
    const pending = previewChatAddress(
      sender,
      { id: 'pending', source, allowPrivateNetwork: true },
      store
    )
    await received.promise
    releaseOwnedChatPreview(sender.sender.id, 'pending')
    expect(await pending).toMatchObject({ status: 'error' })
    await disconnected.promise
  })

  it('refuses a symlink pointing at a network share before local authorization', async () => {
    if (process.platform === 'win32') {
      return
    }
    const path = join(directory, 'remote-link')
    await symlink('//server/share/private', path)
    expect(await previewChatAddress(sender, { id: 'link', source: path }, store)).toMatchObject({
      status: 'error',
      message: 'Network-share links cannot be previewed'
    })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not let a late canceled load revoke a replacement with the same renderer ID', async () => {
    const path = join(directory, 'photo.png')
    await writeFile(path, png)
    const delayed = Promise.withResolvers<string>()
    const admitted = Promise.withResolvers<void>()
    authorize.mockImplementationOnce(() => {
      admitted.resolve()
      return delayed.promise
    })
    const obsolete = previewChatAddress(sender, { id: 'same', source: path }, store)
    await admitted.promise
    const current = await previewChatAddress(sender, { id: 'same', source: path }, store)
    const url = readyUrl(current)
    delayed.resolve(path)
    expect(await obsolete).toMatchObject({ status: 'error' })
    expect(getChatPreviewGrant(url)).toBeDefined()
  })

  it('aborts an active streamed recording when its renderer is destroyed', async () => {
    const wav = Buffer.alloc(256)
    wav.write('RIFF', 0)
    wav.write('WAVE', 8)
    const disconnected = Promise.withResolvers<void>()
    const source = await serve((request, response) => {
      response.setHeader('Content-Type', 'audio/wav')
      if (request.headers.range) {
        response.end(wav)
      } else {
        response.write(wav)
        request.once('close', disconnected.resolve)
      }
    })
    const url = readyUrl(
      await previewChatAddress(sender, { id: 'stream', source, allowPrivateNetwork: true }, store)
    )
    const response = await handleChatAddressPreviewRequest(new Request(url, { referrer: '' }))
    const reader = response.body!.getReader()
    expect((await reader.read()).value?.length).toBeGreaterThan(0)
    sender.sender.emit('destroyed')
    await expect(reader.read()).rejects.toThrow()
    await disconnected.promise
    expect(getChatPreviewGrant(url)).toBeUndefined()
  })

  it('checks ownership and trust on release IPC as well as creation', () => {
    registerChatAddressPreviewHandlers(store)
    const release = ipcHandle.mock.calls.find(
      ([channel]) => channel === 'fs:releaseAddressPreview'
    )?.[1]
    expect(release).toBeDefined()
    expect(() => release({ ...sender, senderFrame: {} }, { id: 'owned' })).toThrow('Untrusted')
  })
})
