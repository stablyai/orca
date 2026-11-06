import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedRuntimeFileTarget } from './file-target'
import { RuntimeStagedFileSaves } from './staged-file-save-commands'
import { StagedFileSaves } from './staged-file-saves'

// The real authorization follows links to the file they name; mirror that without a store.
vi.mock('./chat-scratch-file-root', () => ({
  resolveRuntimeAuthorizedPath: async (path: string) => realpath(path).catch(() => path)
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-staged-commands-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function commands(executionHostId = 'local') {
  return new RuntimeStagedFileSaves(
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only reaches the mocked path authorization.
      requireStore: () => ({}) as RuntimeStore,
      resolveRuntimeFileTarget: async () => ({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save uses only the worktree's id and path.
        worktree: { id: 'wt-1', path: root } as ResolvedRuntimeFileTarget['worktree'],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a host id the route reads.
        executionHostId: executionHostId as ResolvedRuntimeFileTarget['executionHostId']
      })
    },
    new StagedFileSaves({ stagingDir: () => join(root, 'profile', 'staged-saves') })
  )
}

describe('a staged save through the runtime', () => {
  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked target to the file it names, keeping the link',
    async () => {
      writeFileSync(join(root, 'real.json'), 'old')
      symlinkSync(join(root, 'real.json'), join(root, 'link.json'))
      const staged = commands()
      const { saveId } = await staged.begin('conn-1', {
        worktree: 'id:wt-1',
        relativePath: 'link.json',
        totalBytes: 3,
        expectedExecutionHostId: 'local'
      })
      await staged.append('conn-1', saveId, 0, Buffer.from('new'))
      await expect(staged.commit('conn-1', saveId, undefined)).resolves.toEqual({ ok: true })
      expect(lstatSync(join(root, 'link.json')).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(root, 'real.json'), 'utf8')).toBe('new')
    }
  )

  it('refuses a workspace this host reaches over SSH, and an old client that names no host', async () => {
    await expect(
      commands('ssh:target-1').begin('conn-1', {
        worktree: 'id:wt-1',
        relativePath: 'a.txt',
        totalBytes: 1,
        expectedExecutionHostId: 'ssh:target-1'
      })
    ).rejects.toThrow(/not served|SSH/i)
    await expect(
      commands().begin('conn-1', { worktree: 'id:wt-1', relativePath: 'a.txt', totalBytes: 1 })
    ).rejects.toThrow('newer Orca client')
  })
})
