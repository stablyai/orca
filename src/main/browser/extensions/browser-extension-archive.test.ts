import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readBrowserExtensionArchive,
  writeBrowserExtensionArchive
} from './browser-extension-archive'

let parent: string
let target: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'orca-extension-archive-'))
  target = join(parent, 'target')
})
afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('browser extension archives', () => {
  it('unpacks nested files into the target folder', async () => {
    const archive = zipSync({
      'manifest.json': strToU8('{}'),
      js: { 'background.js': strToU8('self.ok = 1') }
    })

    await writeBrowserExtensionArchive(readBrowserExtensionArchive(archive), target)

    expect(readFileSync(join(target, 'js', 'background.js'), 'utf8')).toBe('self.ok = 1')
  })

  it('rejects an archive with an entry that escapes the folder before writing anything', () => {
    const archive = zipSync({ 'manifest.json': strToU8('{}'), '../evil.js': strToU8('pwned') })

    expect(() => readBrowserExtensionArchive(archive)).toThrow('unsafe file name')
    expect(existsSync(join(parent, 'evil.js'))).toBe(false)
  })

  it('re-checks each path when writing', async () => {
    await expect(
      writeBrowserExtensionArchive([{ path: '../evil.js', data: strToU8('pwned') }], target)
    ).rejects.toThrow('unsafe file name')
    expect(existsSync(join(parent, 'evil.js'))).toBe(false)
  })

  it('refuses to overwrite an existing file', async () => {
    const entry = { path: 'a.js', data: strToU8('1') }
    await expect(writeBrowserExtensionArchive([entry, entry], target)).rejects.toThrow()
  })
})
