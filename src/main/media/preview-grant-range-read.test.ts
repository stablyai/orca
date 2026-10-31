import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
vi.mock('../ipc/local-file-access-resolution', () => ({
  resolveLocalFileRequestPath: vi.fn(async (filePath: string) => filePath)
}))
vi.mock('../wsl/wsl-unc-access-gate', () => ({
  guardWslUncPathAccess: vi.fn((_path: string, access: () => Promise<unknown>) => access())
}))

import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { guardWslUncPathAccess } from '../wsl/wsl-unc-access-gate'
import { readLocalFilePreview } from './media-preview-protocol'
import { readPreviewGrantRange } from './preview-grant-range-read'

const emitter = new EventEmitter()
const sender = {
  id: 7101,
  on: vi.fn().mockImplementation((name, callback) => emitter.on(name, callback)),
  removeListener: vi
    .fn()
    .mockImplementation((name, callback) => emitter.removeListener(name, callback))
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked authorization resolver never reads Store members.
const store = {} as Store

describe('readPreviewGrantRange', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-preview-range-'))
  })
  afterEach(async () => {
    emitter.emit('destroyed')
    await rm(directory, { recursive: true, force: true })
  })

  async function mint(name: string, bytes: string): Promise<string> {
    const filePath = join(directory, name)
    await writeFile(filePath, bytes)
    const result = await readLocalFilePreview({ sender }, { filePath }, store, { documents: true })
    return result?.mediaUrl ?? ''
  }

  it('reads a PDF range for the renderer that minted it, and for no other', async () => {
    const url = await mint('doc.pdf', '%PDF-1.4 body')
    expect(new TextDecoder().decode(await readPreviewGrantRange(sender, url, 1, 3))).toBe('PDF')
    await expect(
      readPreviewGrantRange({ ...sender, id: sender.id + 1 }, url, 0, 4)
    ).rejects.toThrow('Preview is no longer available')
  })

  it('never wakes a stopped WSL distro to read a range', async () => {
    const url = await mint('doc.pdf', '%PDF-1.4 body')
    vi.mocked(resolveLocalFileRequestPath).mockClear()
    vi.mocked(guardWslUncPathAccess).mockRejectedValueOnce(new Error('Ubuntu is stopped'))
    await expect(readPreviewGrantRange(sender, url, 0, 4)).rejects.toThrow('Ubuntu is stopped')
    expect(resolveLocalFileRequestPath).not.toHaveBeenCalled()
  })

  it('serves PDF grants only, within bounds, and nothing after teardown', async () => {
    const pdf = await mint('doc.pdf', '%PDF-1.4')
    const image = await mint('shot.svg', '<svg/>')
    await expect(readPreviewGrantRange(sender, image, 0, 4)).rejects.toThrow()
    await expect(readPreviewGrantRange(sender, pdf, -1, 4)).rejects.toThrow('Invalid preview range')
    await expect(readPreviewGrantRange(sender, pdf, 0, 64 * 1024 * 1024)).rejects.toThrow(
      'Invalid preview range'
    )
    emitter.emit('destroyed')
    await expect(readPreviewGrantRange(sender, pdf, 0, 4)).rejects.toThrow(
      'Preview is no longer available'
    )
  })
})
