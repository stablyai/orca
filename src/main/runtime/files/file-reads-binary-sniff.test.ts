import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedRuntimeFileTarget } from './file-target'
import { RuntimeFileReads } from './file-reads'

vi.mock('./chat-scratch-file-root', () => ({
  resolveRuntimeAuthorizedPath: async (path: string) => path
}))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-file-reads-binary-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function reads(): RuntimeFileReads {
  return new RuntimeFileReads({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only reaches the mocked path authorization.
    requireStore: () => ({}) as RuntimeStore,
    resolveRuntimeFileTarget: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only the worktree's id and path.
      worktree: { id: 'wt-1', path: root } as ResolvedRuntimeFileTarget['worktree'],
      executionHostId: 'local'
    })
  })
}

describe('files.read on a host', () => {
  it('refuses a binary whose extension the list does not know, before sending it as text', async () => {
    writeFileSync(join(root, 'libfoo.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x01]))
    await expect(reads().readMobileFile('id:wt-1', 'libfoo.so')).rejects.toThrow('binary_file')
  })

  it('refuses a large one from its first bytes, so the client never pages it in', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61)
    big[100] = 0
    writeFileSync(join(root, 'blob.dat'), big)
    await expect(reads().readMobileFile('id:wt-1', 'blob.dat')).rejects.toThrow('binary_file')
  })

  it('still sends text', async () => {
    writeFileSync(join(root, 'notes.txt'), 'hello\n')
    await expect(reads().readMobileFile('id:wt-1', 'notes.txt')).resolves.toMatchObject({
      content: 'hello\n',
      truncated: false
    })
  })
})
