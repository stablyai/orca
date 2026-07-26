// Empirical proof that the durable write fsyncs the file AND its directory. Counted at the module
// boundary rather than inferred from reading the implementation.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const fsyncTargets: ('file' | 'directory')[] = []

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      fsyncTargets.push(actual.fstatSync(fd).isDirectory() ? 'directory' : 'file')
      return actual.fsyncSync(fd)
    }
  }
})

it('fsyncs the file before rename and the directory after', async () => {
  const { writeFileDurableSync } = await import('./durable-file-write')
  const dir = mkdtempSync(join(tmpdir(), 'orca-fsync-'))
  try {
    const target = join(dir, 'x.json')
    writeFileDurableSync(`${target}.tmp`, target, '{"ok":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"ok":1}')
    expect(fsyncTargets).toEqual(['file', 'directory'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
