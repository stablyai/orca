import {
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gunzipCapped, safeEntryPath, safeExtractTar } from './cloud-transfer-tar'

/** Minimal ustar writer: entries are [name, type, content]. */
function tar(entries: [string, string, string?, string?][]): Buffer {
  const blocks: Buffer[] = []
  for (const [name, type, content = '', mode = '0000644'] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write(`${mode}\0`, 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) {
      sum += byte
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header)
    const data = Buffer.from(content)
    blocks.push(Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-tar-'))
  const dest = join(root, 'dest')
  mkdirSync(dest)
  return { root, dest }
}

describe('safe extraction of VM archives', () => {
  it('rejects absolute, parent-climbing and drive paths', () => {
    expect(safeEntryPath('a/b.txt')).toBe(join('a', 'b.txt'))
    expect(safeEntryPath('./a')).toBe('a')
    expect(safeEntryPath('/etc/passwd')).toBeNull()
    expect(safeEntryPath('a/../../x')).toBeNull()
    expect(safeEntryPath('C:/x')).toBeNull()
  })

  it('writes regular files and dirs, skips links, devices and escapes', async () => {
    const { root, dest } = setup()
    const archive = join(root, 'a.tar')
    writeFileSync(
      archive,
      tar([
        ['notes/', '5'],
        ['notes/todo.md', '0', 'hi'],
        ['link', '2', ''],
        ['hard', '1', ''],
        ['../evil', '0', 'x'],
        ['/abs', '0', 'x'],
        ['fifo', '6', '']
      ])
    )
    const result = await safeExtractTar(archive, dest, { maxBytes: 1024 })
    expect(readFileSync(join(dest, 'notes/todo.md'), 'utf8')).toBe('hi')
    expect(result.files).toBe(1)
    expect(result.skipped.sort()).toEqual(['../evil', '/abs', 'fifo', 'hard', 'link'])
    expect(existsSync(join(root, 'evil'))).toBe(false)
  })

  it('caps total bytes', async () => {
    const { root, dest } = setup()
    const archive = join(root, 'a.tar')
    writeFileSync(archive, tar([['big', '0', 'x'.repeat(2000)]]))
    await expect(safeExtractTar(archive, dest, { maxBytes: 1000 })).rejects.toThrow(
      /larger than allowed/
    )
  })

  it('never writes through a symlinked directory in the destination, and does not clobber', async () => {
    const { root, dest } = setup()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(dest, 'linked'))
    writeFileSync(join(dest, 'keep.txt'), 'mine')
    const archive = join(root, 'a.tar')
    writeFileSync(
      archive,
      tar([
        ['linked/pwned', '0', 'x'],
        ['keep.txt', '0', 'theirs']
      ])
    )
    const result = await safeExtractTar(archive, dest, { maxBytes: 1024, noClobber: true })
    expect(existsSync(join(outside, 'pwned'))).toBe(false)
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('mine')
    expect(result.skipped).toEqual(['linked/pwned', 'keep.txt'])
  })

  it('inflates gzip only up to the cap (gzip bomb)', async () => {
    const { root } = setup()
    writeFileSync(join(root, 'bomb.gz'), gzipSync(Buffer.alloc(5 * 1024 * 1024)))
    await expect(
      gunzipCapped(join(root, 'bomb.gz'), join(root, 'out'), 1024 * 1024)
    ).rejects.toThrow(/larger than allowed/)
    expect(existsSync(join(root, 'out'))).toBe(false)
    writeFileSync(join(root, 'ok.gz'), gzipSync(Buffer.from('hello')))
    expect(await gunzipCapped(join(root, 'ok.gz'), join(root, 'ok'), 1024)).toBe(5)
  })

  it('skips .git paths (any case), keeps the exec bit, steps over dir data, reads pax paths by bytes', async () => {
    const { root, dest } = setup()
    const archive = join(root, 'a.tar')
    const longName = `dir/${'é'.repeat(60)}.sh`
    const record = ` path=${longName}\n`
    let length = Buffer.byteLength(record) + 2
    length = Buffer.byteLength(`${length}${record}`)
    writeFileSync(
      archive,
      tar([
        ['.git/hooks/pre-commit', '0', 'evil'],
        ['sub/.GIT/config', '0', 'evil'],
        ['run.sh', '0', '#!/bin/sh', '0000755'],
        ['odd-dir/', '5', 'payload-that-must-be-skipped'],
        ['pax', 'x', `${length}${record}`],
        ['ignored-name', '0', 'pax body']
      ])
    )
    const result = await safeExtractTar(archive, dest, { maxBytes: 4096 })
    expect(existsSync(join(dest, '.git'))).toBe(false)
    expect(existsSync(join(dest, 'sub', '.GIT'))).toBe(false)
    expect(result.skipped).toEqual(['.git/hooks/pre-commit', 'sub/.GIT/config'])
    expect(statSync(join(dest, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(existsSync(join(dest, 'odd-dir'))).toBe(true)
    expect(readFileSync(join(dest, longName), 'utf8')).toBe('pax body')
  })
})
