import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishSharedTree, sharedTreeStagingPath } from './shared-tree-publish.mjs'

const roots = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true })
  }
})

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-shared-tree-'))
  roots.push(root)
  return root
}

function writeTree(dir, content) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'payload'), content)
  return dir
}

const readPayload = (dir) => readFileSync(path.join(dir, 'payload'), 'utf8')
const isGood = (dir) => existsSync(path.join(dir, 'payload')) && readPayload(dir) !== 'bad'

describe('publishSharedTree', () => {
  it('names staging trees uniquely beside the entry', () => {
    expect(sharedTreeStagingPath('/x/entry', () => 'u1')).toBe(`/x/entry.staging-${process.pid}-u1`)
  })

  it('renames a staged tree into an empty slot', () => {
    const root = makeRoot()
    const entry = path.join(root, 'entry')
    const staging = writeTree(sharedTreeStagingPath(entry), 'new')
    expect(publishSharedTree(staging, entry, { isUsable: isGood })).toBe(true)
    expect(readPayload(entry)).toBe('new')
    expect(readdirSync(root)).toEqual(['entry'])
  })

  it('never replaces a usable entry, and drops its own staging tree', () => {
    const root = makeRoot()
    const entry = writeTree(path.join(root, 'entry'), 'old')
    const staging = writeTree(sharedTreeStagingPath(entry), 'new')
    expect(publishSharedTree(staging, entry, { isUsable: isGood })).toBe(false)
    expect(readPayload(entry)).toBe('old')
    expect(readdirSync(root)).toEqual(['entry'])
  })

  it('lets exactly one of two racing publishers win', () => {
    const root = makeRoot()
    const entry = path.join(root, 'entry')
    const first = writeTree(
      sharedTreeStagingPath(entry, () => 'a'),
      'first'
    )
    const second = writeTree(
      sharedTreeStagingPath(entry, () => 'b'),
      'second'
    )
    // The second passes its pre-check, then the first lands just before its own rename does.
    const raced = publishSharedTree(second, entry, {
      isUsable: isGood,
      rename: (from, to) => {
        expect(publishSharedTree(first, entry, { isUsable: isGood })).toBe(true)
        renameSync(from, to)
      }
    })
    expect(raced).toBe(false)
    expect(readPayload(entry)).toBe('first')
    expect(readdirSync(root)).toEqual(['entry'])
  })

  it('quarantines an unusable entry and publishes over it', () => {
    const root = makeRoot()
    const entry = writeTree(path.join(root, 'entry'), 'bad')
    const staging = writeTree(sharedTreeStagingPath(entry), 'new')
    expect(publishSharedTree(staging, entry, { isUsable: isGood })).toBe(true)
    expect(readPayload(entry)).toBe('new')
    expect(readdirSync(root)).toEqual(['entry'])
  })

  it('puts the quarantined entry back when the swap fails', () => {
    const root = makeRoot()
    const entry = writeTree(path.join(root, 'entry'), 'bad')
    const staging = writeTree(sharedTreeStagingPath(entry), 'new')
    const failingRename = () => {
      throw new Error('EPERM')
    }
    expect(publishSharedTree(staging, entry, { isUsable: isGood, rename: failingRename })).toBe(
      false
    )
    expect(readPayload(entry)).toBe('bad')
    expect(readdirSync(root)).toEqual(['entry'])
  })
  it('never quarantines a good entry a sibling published while the bad one was judged', () => {
    const root = makeRoot()
    const entry = writeTree(path.join(root, 'entry'), 'bad')
    const staging = writeTree(sharedTreeStagingPath(entry), 'mine')
    const sibling = writeTree(path.join(root, 'sibling'), 'sibling')
    const judgeThenRace = (dir) => {
      const usable = isGood(dir)
      rmSync(entry, { recursive: true, force: true })
      renameSync(sibling, entry)
      return usable
    }
    expect(publishSharedTree(staging, entry, { isUsable: judgeThenRace })).toBe(false)
    expect(readPayload(entry)).toBe('sibling')
    expect(readdirSync(root)).toEqual(['entry'])
  })
})
