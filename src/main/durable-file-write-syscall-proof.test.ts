// Empirical proof that the durable write fsyncs the file, and the directory where the platform
// allows it. Counted at the module boundary rather than inferred from reading the implementation.
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

/** Why the rename is recorded too: an fsync moved after the rename still fsyncs a file, so a
 *  fsync-only log reads identically for the correct and the broken order. The rename is the boundary
 *  the ordering is defined against, so it has to appear in the same sequence. */
const syscalls: ('fsync:file' | 'fsync:directory' | 'rename')[] = []

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      syscalls.push(actual.fstatSync(fd).isDirectory() ? 'fsync:directory' : 'fsync:file')
      return actual.fsyncSync(fd)
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike) => {
      syscalls.push('rename')
      return actual.renameSync(from, to)
    }
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
