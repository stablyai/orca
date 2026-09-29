import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, mkdirMock, openMock, readdirMock, rmMock, unlinkMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  openMock: vi.fn(),
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
  unlinkMock: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({ authorizeExternalPath: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readdir: readdirMock,
  rm: rmMock,
  unlink: unlinkMock
}))

import { importOneSource } from './filesystem-import-local'
import { recursiveCopyDir } from './filesystem-import-local-tree-copy'

type EntryKind = 'directory' | 'file' | 'symlink' | 'unsupported'

function statFor(kind: EntryKind) {
  return {
    size: 7,
    ino: 1,
    dev: 1,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  }
}

const source = resolve('import-fixture', 'incoming')
const destination = resolve('import-fixture', 'folder-workspace')
const target = join(destination, 'incoming')
const stats = new Map<string, ReturnType<typeof statFor>>()
const entries = new Map<string, { name: string; kind: EntryKind }[]>()

function addEntry(parent: string, name: string, kind: EntryKind): string {
  const path = join(parent, name)
  stats.set(path, statFor(kind))
  entries.set(parent, [...(entries.get(parent) ?? []), { name, kind }])
  return path
}

beforeEach(() => {
  vi.resetAllMocks()
  stats.clear()
  entries.clear()
  stats.set(source, statFor('directory'))
  lstatMock.mockImplementation(async (path: string) => {
    const stat = stats.get(path)
    if (stat) {
      return stat
    }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  readdirMock.mockImplementation(async (path: string) =>
    (entries.get(path) ?? []).map(({ name, kind }) => ({ name, ...statFor(kind) }))
  )
  mkdirMock.mockResolvedValue(undefined)
  rmMock.mockResolvedValue(undefined)
  unlinkMock.mockResolvedValue(undefined)
  openMock.mockRejectedValue(new Error('unexpected file copy'))
})

describe('local directory import rollback ownership', () => {
  it.each(['EEXIST', 'EACCES', 'EPERM'])(
    'does not remove output after root mkdir %s',
    async (code) => {
      mkdirMock.mockRejectedValue(Object.assign(new Error(code), { code }))

      expect(await importOneSource(source, destination, new Set())).toEqual({
        sourcePath: source,
        status: 'failed',
        reason: code
      })
      expect(mkdirMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: false })
      expect(rmMock).not.toHaveBeenCalled()
      expect(openMock).not.toHaveBeenCalled()
    }
  )

  it.each(['existing', 'reserved'])(
    'preserves a late conflict after deconflicting a %s name',
    async (conflict) => {
      const reserved = new Set<string>()
      if (conflict === 'existing') {
        stats.set(target, statFor('directory'))
      } else {
        reserved.add('incoming')
      }
      mkdirMock.mockRejectedValue(Object.assign(new Error('late conflict'), { code: 'EEXIST' }))

      expect(await importOneSource(source, destination, reserved)).toMatchObject({
        status: 'failed'
      })
      expect(mkdirMock).toHaveBeenCalledExactlyOnceWith(join(destination, 'incoming copy'), {
        recursive: false
      })
      expect(rmMock).not.toHaveBeenCalled()
    }
  )

  it('cleans its directory when reading it fails after creation', async () => {
    readdirMock.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('source unreadable'))

    expect(await importOneSource(source, destination, new Set())).toMatchObject({
      status: 'failed',
      reason: 'source unreadable'
    })
    expect(rmMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: true, force: true })
  })

  it('keeps the copy error when best-effort cleanup also fails', async () => {
    addEntry(source, 'lost.txt', 'file')
    openMock.mockRejectedValue(new Error('source changed'))
    rmMock.mockRejectedValue(new Error('cleanup denied'))

    expect(await importOneSource(source, destination, new Set())).toMatchObject({
      status: 'failed',
      reason: 'source changed'
    })
    expect(rmMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: true, force: true })
  })

  it('rolls back the owned root once when a nested mkdir fails', async () => {
    addEntry(source, 'child', 'directory')
    mkdirMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('nested conflict'))

    expect(await importOneSource(source, destination, new Set())).toMatchObject({
      status: 'failed',
      reason: 'nested conflict'
    })
    expect(mkdirMock.mock.calls).toEqual([
      [target, { recursive: false }],
      [join(target, 'child'), { recursive: false }]
    ])
    expect(rmMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: true, force: true })
  })

  it.each(['symlink', 'unsupported', 'missing'])(
    'rolls back the owned root once when a nested entry becomes %s',
    async (kind) => {
      const child = addEntry(source, 'child', 'directory')
      const file = addEntry(child, 'changed.txt', 'file')
      if (kind === 'missing') {
        stats.delete(file)
      } else {
        stats.set(file, statFor(kind === 'symlink' ? 'symlink' : 'unsupported'))
      }

      expect(await importOneSource(source, destination, new Set())).toMatchObject({
        status: 'failed'
      })
      expect(mkdirMock).toHaveBeenCalledTimes(2)
      expect(rmMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: true, force: true })
      expect(openMock).not.toHaveBeenCalled()
    }
  )

  it.each(['top-level', 'nested'])(
    'skips a %s symlink before creating output',
    async (location) => {
      if (location === 'top-level') {
        stats.set(source, statFor('symlink'))
      } else {
        addEntry(addEntry(source, 'child', 'directory'), 'link', 'symlink')
      }

      expect(await importOneSource(source, destination, new Set())).toMatchObject({
        status: 'skipped',
        reason: 'symlink'
      })
      expect(mkdirMock).not.toHaveBeenCalled()
      expect(rmMock).not.toHaveBeenCalled()
    }
  )

  it('copies nested files with exclusive destinations and preserves rename metadata', async () => {
    const file = addEntry(addEntry(source, 'child', 'directory'), 'data.txt', 'file')
    const renamedTarget = join(destination, 'incoming copy')
    const chunks: Buffer[] = []
    const closeSource = vi.fn().mockResolvedValue(undefined)
    const closeDestination = vi.fn().mockResolvedValue(undefined)
    openMock.mockImplementation(async (_path: string, flags: unknown) => {
      if (flags === 'wx') {
        return {
          createWriteStream: () =>
            new Writable({
              write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk))
                callback()
              }
            }),
          close: closeDestination
        }
      }
      return {
        stat: async () => statFor('file'),
        createReadStream: () => Readable.from([Buffer.from('payload')]),
        close: closeSource
      }
    })

    expect(await importOneSource(source, destination, new Set(['incoming']))).toEqual({
      sourcePath: source,
      status: 'imported',
      destPath: renamedTarget,
      kind: 'directory',
      renamed: true
    })
    expect(mkdirMock.mock.calls).toEqual([
      [renamedTarget, { recursive: false }],
      [join(renamedTarget, 'child'), { recursive: false }]
    ])
    expect(openMock.mock.calls).toEqual([
      [file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)],
      [join(renamedTarget, 'child', 'data.txt'), 'wx']
    ])
    expect(Buffer.concat(chunks).toString()).toBe('payload')
    expect(closeSource).toHaveBeenCalledOnce()
    expect(closeDestination).toHaveBeenCalledOnce()
    expect(rmMock).not.toHaveBeenCalled()
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('leaves directory cleanup out of a top-level file failure', async () => {
    stats.set(source, statFor('file'))

    expect(await importOneSource(source, destination, new Set())).toMatchObject({
      status: 'failed'
    })
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('cleans an owned root when the copy helper is called directly', async () => {
    const failure = new Error('read failed')
    readdirMock.mockRejectedValue(failure)

    await expect(recursiveCopyDir(source, target)).rejects.toBe(failure)
    expect(rmMock).toHaveBeenCalledExactlyOnceWith(target, { recursive: true, force: true })
  })
})
