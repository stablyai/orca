import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyPrivateTree,
  hardlinkTree,
  makeTreeReadOnly,
  makeTreeReadOnlyAsync,
  shareTree,
  shareTreeAsync
} from './space-sharing-copy.mjs'

const roots: string[] = []

describe('asynchronous immutable sharing', () => {
  it('preserves read-only source and relative symlinks on the execution host', async () => {
    const { root, source } = makeTree()
    await makeTreeReadOnlyAsync(source)
    const destination = path.join(root, 'async-copy')
    await shareTreeAsync(source, destination)
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
    expect(statSync(path.join(destination, 'nested', 'file')).mode & 0o222).toBe(0)
  })

  it('removes partial copies before its Linux hardlink fallback', async () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'async-copy')
    const reflink = async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(path.join(target, 'partial'), 'partial')
      throw new Error('unsupported reflink')
    }
    expect(await shareTreeAsync(source, destination, { platform: 'linux', reflink })).toBe(
      'hardlink'
    )
    expect(existsSync(path.join(destination, 'partial'))).toBe(false)
    expect(statSync(path.join(destination, 'nested', 'file')).ino).toBe(
      statSync(path.join(source, 'nested', 'file')).ino
    )
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })
})

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeTree(): { root: string; source: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-share-'))
  roots.push(root)
  const source = path.join(root, 'source')
  mkdirSync(path.join(source, 'nested'), { recursive: true })
  writeFileSync(path.join(source, 'nested', 'file'), 'contents')
  symlinkSync(path.join('nested', 'file'), path.join(source, 'relative-link'))
  return { root, source }
}

describe('shareTree', () => {
  it('clears a part-way tree before trying the next mechanism', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'shared')
    const reflink = (_source: string, target: string) => {
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'half-written'), 'partial')
      throw new Error('reflink failed midway')
    }
    expect(shareTree(source, destination, { platform: 'linux', reflink })).toBe('hardlink')
    expect(existsSync(path.join(destination, 'half-written'))).toBe(false)
  })
})

describe('makeTreeReadOnly', () => {
  it('turns an extract-over-dist write into an error instead of silent shared corruption', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'linked')
    hardlinkTree(source, destination)
    makeTreeReadOnly(destination)
    expect(() => writeFileSync(path.join(destination, 'nested', 'file'), 'mutated')).toThrow()
    expect(readFileSync(path.join(source, 'nested', 'file'), 'utf8')).toBe('contents')
  })

  it.runIf(process.platform !== 'win32')('preserves setuid, which chrome-sandbox needs', () => {
    const { source } = makeTree()
    const sandbox = path.join(source, 'chrome-sandbox')
    writeFileSync(sandbox, 'binary')
    chmodSync(sandbox, 0o4755)
    makeTreeReadOnly(source)
    expect(statSync(sandbox).mode & 0o4000).toBe(0o4000)
    expect(statSync(sandbox).mode & 0o222).toBe(0)
  })
})

describe('copyPrivateTree', () => {
  it.runIf(process.platform !== 'win32')(
    'hands back a tree the caller can patch, even from a write-protected source',
    () => {
      const { root, source } = makeTree()
      const destination = path.join(root, 'private')
      makeTreeReadOnly(source)
      copyPrivateTree(source, destination)
      // Private copy inherits shared-cache read-only modes; restore owner write or dev Info.plist patch fails.
      expect(() => writeFileSync(path.join(destination, 'nested', 'file'), 'patched')).not.toThrow()
      expect(readFileSync(path.join(source, 'nested', 'file'), 'utf8')).toBe('contents')
    }
  )
})
