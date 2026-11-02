import { describe, expect, it } from 'vitest'
import { parsePluginGitTree, readPluginGitBatchBlobs } from './plugin-git-tree'

const OBJECT = 'a'.repeat(40)

function tree(...records: string[]): Buffer {
  return Buffer.from(records.map((record) => `${record}\0`).join(''))
}

describe('parsePluginGitTree', () => {
  it('parses directories and files with their executable bit', () => {
    expect(
      parsePluginGitTree(
        tree(`040000 tree ${OBJECT}       -\tbin`, `100755 blob ${OBJECT}      12\tbin/run`)
      )
    ).toEqual([
      { kind: 'tree', path: 'bin' },
      { kind: 'blob', path: 'bin/run', object: OBJECT, size: 12, executable: true }
    ])
  })

  it.each([
    ['a symlink', `120000 blob ${OBJECT} 5\tlink`, 'symlinks'],
    ['a submodule', `160000 commit ${OBJECT} -\tmodule`, 'submodules'],
    ['a SHA-256 object', `100644 blob ${'a'.repeat(64)} 5\tfile`, 'unknown entries'],
    ['a .git directory', `040000 tree ${OBJECT} -\t.GIT`, 'unsafe plugin path'],
    ['a .git name hidden by a zero-width joiner', `100644 blob ${OBJECT} 5\t.g\u200dit`, 'unsafe'],
    ['an 8.3 .git alias', `100644 blob ${OBJECT} 5\tGIT~1`, 'unsafe plugin path'],
    ['a Windows device name', `100644 blob ${OBJECT} 5\tcon.txt`, 'unsafe plugin path'],
    ['a file without its directory', `100644 blob ${OBJECT} 5\tdir/file`, 'missing directory']
  ])('rejects %s', (_label, record, message) => {
    expect(() => parsePluginGitTree(tree(record))).toThrow(message)
  })

  it('rejects a .git directory below the root', () => {
    expect(() =>
      parsePluginGitTree(tree(`040000 tree ${OBJECT} -\tsub`, `040000 tree ${OBJECT} -\tsub/.git`))
    ).toThrow('unsafe plugin path')
  })

  it('rejects paths that collide on case-insensitive filesystems', () => {
    expect(() =>
      parsePluginGitTree(tree(`100644 blob ${OBJECT} 1\tREADME`, `100644 blob ${OBJECT} 1\treadme`))
    ).toThrow('colliding')
  })

  it('rejects trees over the byte budget before any blob is read', () => {
    expect(() => parsePluginGitTree(tree(`100644 blob ${OBJECT} 99999999999\tbig`))).toThrow(
      'byte limit'
    )
  })
})

describe('readPluginGitBatchBlobs', () => {
  const entries = parsePluginGitTree(tree(`100644 blob ${OBJECT} 3\tfile`))

  it('returns exact blob bytes', () => {
    const blobs = readPluginGitBatchBlobs(Buffer.from(`${OBJECT} blob 3\nabc\n`), entries)
    expect(blobs.get(OBJECT)?.toString()).toBe('abc')
  })

  it.each([
    ['a size mismatch', `${OBJECT} blob 4\nabcd\n`],
    ['a different object', `${'b'.repeat(40)} blob 3\nabc\n`],
    ['truncated data', `${OBJECT} blob 3\nab`],
    ['trailing data', `${OBJECT} blob 3\nabc\nextra`]
  ])('rejects %s', (_label, output) => {
    expect(() => readPluginGitBatchBlobs(Buffer.from(output), entries)).toThrow()
  })
})
