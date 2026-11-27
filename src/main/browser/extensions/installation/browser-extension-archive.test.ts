import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { expect, it } from 'vitest'
import {
  readBrowserExtensionArchive,
  writeBrowserExtensionArchive
} from './browser-extension-archive'

it('extracts dot-prefixed child names while refusing parent-directory entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-extension-archive-'))
  try {
    const archive = zipSync({
      '..assets/icon.svg': Buffer.from('<svg/>'),
      'ordinary.txt': Buffer.from('ordinary')
    })
    await writeBrowserExtensionArchive(await readBrowserExtensionArchive(archive), root)
    expect(await readFile(join(root, '..assets/icon.svg'), 'utf8')).toBe('<svg/>')
    expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('ordinary')
    await expect(
      writeBrowserExtensionArchive([{ path: '../escape', data: Buffer.from('outside') }], root)
    ).rejects.toThrow('unsafe file name')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
