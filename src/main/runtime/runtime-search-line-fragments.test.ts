import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  checkRgAvailableMock,
  resolveAuthorizedPathMock,
  wslAwareSpawnMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

type MockRuntimeSearchChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function createRuntimeSearchChild(): MockRuntimeSearchChild {
  const child = new EventEmitter() as MockRuntimeSearchChild
  child.stdout = new EventEmitter() as MockRuntimeSearchChild['stdout']
  child.stdout.setEncoding = vi.fn()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

async function flushRuntimeSearchMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('assembles a fragmented runtime search record without rescanning the carry', async () => {
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'local'
      }))
    })
    const child = createRuntimeSearchChild()
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    checkRgAvailableMock.mockResolvedValue(true)
    wslAwareSpawnMock.mockReturnValue(child)
    const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
      query: 'needle',
      maxResults: 10
    })
    await flushRuntimeSearchMicrotasks()
    const line = JSON.stringify({
      type: 'match',
      data: {
        path: { text: '/repo/file.ts' },
        line_number: 1,
        lines: { text: `needle🐋${'x'.repeat(128 * 1024)}` },
        submatches: [{ start: 0, end: 6 }]
      }
    })
    const originalSplit = String.prototype.split
    let scanned = 0
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number
    ) {
      if (separator === '\n') {
        scanned += this.length
      }
      return Reflect.apply(originalSplit, this, [separator, limit])
    })
    try {
      for (let offset = 0; offset < line.length; offset += 1024) {
        child.stdout.emit('data', line.slice(offset, offset + 1024))
      }
      child.emit('close', 0, null)
    } finally {
      spy.mockRestore()
    }
    const result = await resultPromise
    expect(result.totalMatches).toBe(1)
    expect(result.files[0].filePath).toBe('/repo/file.ts')
    expect(result.files[0].matches[0].lineContent).toContain('needle🐋')
    expect(scanned).toBeLessThanOrEqual(line.length * 2)
    expect(child.stdout.listenerCount('data')).toBe(0)
  })
})
