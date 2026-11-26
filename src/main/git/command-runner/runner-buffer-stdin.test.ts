import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'

// Why real git spawns stall under gate load; the default 30s budget flakes.
vi.setConfig({ testTimeout: 120_000 })

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTree(root)))
})

it('delivers stdin to buffered Git reads', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'orca-git-buffer-stdin-'))
  roots.push(repository)
  await gitExecFileAsync(['init', '--quiet'], { cwd: repository })

  // Why a short timeout: a dropped stdin leaves Git waiting for EOF instead of failing.
  const { stdout } = await gitExecFileAsyncBuffer(['hash-object', '--stdin'], {
    cwd: repository,
    stdin: 'hello\n',
    timeout: 10_000
  })

  expect(stdout.toString().trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
})
