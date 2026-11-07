import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, showOpenDialog } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }) => Promise<unknown>>(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }) => Promise<unknown>) =>
      handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: () => null },
  shell: {},
  dialog: { showOpenDialog }
}))

import { registerShellHandlers } from './shell'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-repo-icon-'))
  handlers.clear()
  showOpenDialog.mockReset()
  registerShellHandlers({ getSshTarget: () => undefined }, () => [])
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function pickFile(name: string, bytes: Uint8Array): Promise<unknown> {
  const path = join(directory, name)
  await writeFile(path, bytes)
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
  const handler = handlers.get('shell:pickRepoIconImage')
  if (!handler) {
    throw new Error('Missing repo icon picker')
  }
  return handler({ sender: {} })
}

describe('project icon image input', () => {
  it('admits a case-insensitive JPEG source for renderer decoding', async () => {
    const bytes = Buffer.from('selected image bytes')
    await expect(pickFile('photo.JPG', bytes)).resolves.toEqual({
      dataUrl: 'data:image/jpeg;base64,c2VsZWN0ZWQgaW1hZ2UgYnl0ZXM=',
      fileName: 'photo.JPG'
    })
  })

  it('accepts a source larger than the stored icon budget for downscaling', async () => {
    const result = await pickFile('photo.jpg', new Uint8Array(1024 * 1024))
    expect(result).toEqual(
      expect.objectContaining({
        fileName: 'photo.jpg',
        dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,AAAA/)
      })
    )
  })

  it('rejects oversized sources and non-image extensions', async () => {
    await expect(pickFile('huge.png', new Uint8Array(10 * 1024 * 1024 + 1))).resolves.toMatchObject(
      {
        ok: false,
        errorCode: 'sourceTooLarge'
      }
    )
    await expect(pickFile('script.html', Buffer.from('<html/>'))).resolves.toMatchObject({
      ok: false,
      errorCode: 'unsupportedImage'
    })
  })

  it('keeps cancellation silent', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handlers.get('shell:pickRepoIconImage')?.({ sender: {} })).resolves.toBeNull()
  })
})
