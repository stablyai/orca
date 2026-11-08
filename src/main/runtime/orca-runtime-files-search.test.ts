import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  bundledRipgrepCommandMock,
  resolveAuthorizedPathMock,
  wslAwareSpawnMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { SEARCH_TIMEOUT_MS } from '../../shared/text-search'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem/access/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock('../ripgrep/bundled-ripgrep-path', async () =>
  (await import('./orca-runtime-files-mock-registry')).bundledRipgrepPathModuleMock()
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

  it('keeps concurrent runtime clients on the same root independent during cancellation', async () => {
    const { commands } = createRuntimeFileCommands()
    const firstChild = createRuntimeSearchChild()
    const secondChild = createRuntimeSearchChild()
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    wslAwareSpawnMock.mockImplementation((_command, args: string[]) =>
      args.includes('first') ? firstChild : secondChild
    )
    const controller = new AbortController()
    const first = commands.searchRuntimeFiles(
      'id:wt-1',
      { query: 'first' },
      { signal: controller.signal }
    )
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = commands.searchRuntimeFiles('id:wt-1', { query: 'second' })
    await vi.waitFor(() => expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2))
    expect(firstChild.kill).not.toHaveBeenCalled()
    controller.abort()
    await firstRejected
    expect(firstChild.kill).toHaveBeenCalledOnce()
    expect(secondChild.kill).not.toHaveBeenCalled()
    secondChild.emit('close', 1, null)
    await expect(second).resolves.toMatchObject({ totalMatches: 0, truncated: false })
  })

  it('settles and detaches runtime rg searches when timeout kill is ignored', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo'
      },
      executionHostId: 'local'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const child = createRuntimeSearchChild()
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    wslAwareSpawnMock.mockReturnValue(child)

    const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
      query: 'needle',
      maxResults: 10
    })
    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS)

    await expect(resultPromise).resolves.toMatchObject({
      files: [],
      totalMatches: 0,
      truncated: true
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(bundledRipgrepCommandMock).toHaveBeenCalledWith({ wsl: false })
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      '/bundled/rg',
      expect.any(Array),
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it.each(['ignored', 'erroring'] as const)(
    'publishes capped results and detaches when termination is %s',
    async (termination) => {
      const { commands } = createRuntimeFileCommands()
      const child = createRuntimeSearchChild()
      if (termination === 'erroring') {
        child.kill.mockImplementation(() => {
          child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))
          return false
        })
      }
      resolveAuthorizedPathMock.mockResolvedValue('/repo')
      wslAwareSpawnMock.mockReturnValue(child)
      const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
        query: 'needle',
        maxResults: 2
      })
      let settled = false
      void resultPromise.then(() => {
        settled = true
      })
      await flushRuntimeSearchMicrotasks()
      const record = JSON.stringify({
        type: 'match',
        data: {
          path: { text: './example.txt' },
          lines: { text: 'needle needle\n' },
          line_number: 1,
          submatches: [
            { start: 0, end: 6 },
            { start: 7, end: 13 }
          ]
        }
      })
      expect(() => child.stdout.emit('data', `${record}\n{"type":"match"`)).not.toThrow()
      await flushRuntimeSearchMicrotasks()

      expect(settled).toBe(true)
      await expect(resultPromise).resolves.toMatchObject({
        totalMatches: 2,
        truncated: true,
        files: [{ matches: [{ column: 1 }, { column: 8 }] }]
      })
      expect(child.kill).toHaveBeenCalledOnce()
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
