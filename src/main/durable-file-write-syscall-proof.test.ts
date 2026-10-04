// Empirical proof that the durable write fsyncs the file, and the directory where the platform
// allows it. Counted at the module boundary rather than inferred from reading the implementation.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

/** Why the rename is recorded too: an fsync moved after the rename still fsyncs a file, so a
 *  fsync-only log reads identically for the correct and the broken order. The rename is the boundary
 *  the ordering is defined against, so it has to appear in the same sequence. */
const syscalls: ('fsync:file' | 'fsync:directory' | 'rename' | 'link')[] = []

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      actual.fsyncSync(fd)
      syscalls.push(actual.fstatSync(fd).isDirectory() ? 'fsync:directory' : 'fsync:file')
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      actual.renameSync(from, to)
      syscalls.push('rename')
    },
    linkSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      actual.linkSync(from, to)
      syscalls.push('link')
    }
  }
})

it('publishes a new file durably and cannot replace an existing destination', async () => {
  const { publishFileDurableSync } = await import('./durable-file-write')
  const dir = mkdtempSync(join(tmpdir(), 'orca-publish-fsync-'))
  try {
    const supported = directoryFsyncSupported(dir)
    const staged = join(dir, 'staged')
    const target = join(dir, 'target')
    writeFileSync(staged, 'first')
    const fd = openSync(staged, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syscalls.length = 0
    expect(publishFileDurableSync(staged, target)).toBe(true)
    expect(syscalls).toEqual(supported ? ['link', 'fsync:directory'] : ['link'])
    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('first')
    writeFileSync(staged, 'second')
    syscalls.length = 0
    expect(publishFileDurableSync(staged, target)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('first')
    expect(readFileSync(staged, 'utf8')).toBe('second')
    expect(syscalls).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Windows cannot open a directory for fsync, and some filesystems reject it; probe rather than
 *  assume, so the expectation tracks the real platform instead of a hardcoded OS list. */
function directoryFsyncSupported(directory: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable in a probe.
      }
    }
  }
}

it('fsyncs the file before rename, and the directory after where supported', async () => {
  const { writeFileDurableSync } = await import('./durable-file-write')
  const dir = mkdtempSync(join(tmpdir(), 'orca-fsync-'))
  try {
    const supported = directoryFsyncSupported(dir)
    syscalls.length = 0 // Discard the probe's own fsync.
    const target = join(dir, 'x.json')
    writeFileDurableSync(`${target}.tmp`, target, '{"ok":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"ok":1}')
    // The data fsync must precede the rename: that ordering is the entire fix. Publishing the name
    // first is what lets a crash expose a stale or zero-length file.
    expect(syscalls).toEqual(
      supported ? ['fsync:file', 'rename', 'fsync:directory'] : ['fsync:file', 'rename']
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
