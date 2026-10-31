import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, showOpenDialog } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<unknown>>(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler)
  },
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
  return handler()
}

describe('project icon image input', () => {
  it.each([
    ['logo.svg', 'image/svg+xml'],
    ['photo.JPG', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['favicon.ico', 'image/x-icon'],
    ['icon.webp', 'image/webp'],
    ['icon.gif', 'image/gif'],
    ['icon.bmp', 'image/bmp'],
    ['icon.avif', 'image/avif'],
    ['icon.png', 'image/png']
  ])('admits %s for renderer decoding', async (name, mime) => {
    const bytes = Buffer.from('selected image bytes')
    await expect(pickFile(name, bytes)).resolves.toEqual({
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      fileName: name
    })
    const options = showOpenDialog.mock.calls[0]?.[0]
    expect(options.filters[0].extensions).toContain(name.split('.').at(-1)?.toLowerCase())
  })

  it('accepts a source larger than the stored icon budget for downscaling', async () => {
    const result = await pickFile('photo.jpg', new Uint8Array(1024 * 1024))
    expect(result).toEqual(expect.objectContaining({ fileName: 'photo.jpg' }))
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
    await expect(handlers.get('shell:pickRepoIconImage')?.()).resolves.toBeNull()
  })
})
