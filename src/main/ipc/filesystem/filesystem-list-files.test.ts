import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as BundledRipgrepPath from '../../ripgrep/bundled-ripgrep-path'

const {
  spawnMock,
  resolveAuthorizedPathMock,
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  // Transitive runner imports require both child_process exports in the mock.
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))

vi.mock('./access/filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('../../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('../local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'
import { EventEmitter } from 'node:events'
import type { Store } from '../../persistence/loading-store/store'
import type { ChildProcess } from 'node:child_process'

const BUNDLED_RG = '/bundled/rg'

function createMockProcess(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess
  ;(p as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (p as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(p as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(p as unknown as Record<string, unknown>).kill = vi.fn()
  ;(p as unknown as Record<string, unknown>).exitCode = null
  ;(p as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(p, 'pid', { configurable: true, value: 1 })

  return p
}

describe('filesystem-list-files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : BUNDLED_RG
    )
  })

  it('counts NUL-delimited filenames containing newlines as one result each', async () => {
    const child = createMockProcess()
    spawnMock.mockReturnValue(child)
    const store: Store = Object.create(null)
    const promise = listQuickOpenFiles('/repo', store, undefined, undefined, 2)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    child.stdout?.emit('data', 'first\nsecond.ts\0trailing\r\0third.ts\0')
    await expect(promise).resolves.toEqual(['first\nsecond.ts', 'trailing\r'])
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects a synchronous launch failure before cleanup has been initialized', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and workspace lookup are mocked above.
    await expect(listQuickOpenFiles('/repo', {} as Store)).rejects.toThrow('EMFILE')
  })
})
