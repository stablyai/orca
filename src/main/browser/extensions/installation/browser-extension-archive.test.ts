import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  readBrowserExtensionArchive,
  writeBrowserExtensionArchive
} from './browser-extension-archive'
import { readBrowserExtensionIconDataUrl } from './browser-extension-manifest'

describe('dot-prefixed extension folders', () => {
  it('extracts and reads files under names that only start with two dots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-extension-archive-'))
    try {
      const archive = zipSync({
        'manifest.json': Buffer.from('{}'),
        '..assets/icon.svg': Buffer.from('<svg/>')
      })
      await writeBrowserExtensionArchive(await readBrowserExtensionArchive(archive), root)

      expect(await readFile(join(root, '..assets/icon.svg'), 'utf8')).toBe('<svg/>')
      expect(await readBrowserExtensionIconDataUrl(root, '..assets/icon.svg')).toMatch(
        /^data:image\/svg\+xml;base64,/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still refuses parent references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-extension-archive-'))
    try {
      for (const path of ['../escape', 'a/../../escape']) {
        await expect(
          writeBrowserExtensionArchive([{ path, data: Buffer.from('outside') }], root)
        ).rejects.toThrow('unsafe file name')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
