import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const FOLDER_RECORD = { id: 'folder:hub-a', path: '/work/hub', displayName: 'Hub' }

function answerFolder(overrides: Record<string, () => unknown> = {}) {
  return async (method: string) => {
    if (overrides[method]) {
      return overrides[method]()
    }
    if (method === 'worktree.show') {
      return okFixture('req_show', { worktree: FOLDER_RECORD })
    }
    if (method === 'status.get') {
      return okFixture('req_status', { capabilities: ['folder-workspace.unique-id-mutation.v1'] })
    }
    if (method === 'folderWorkspace.update') {
      return okFixture('req_update', { folderWorkspace: { id: 'hub-a', name: 'Renamed' } })
    }
    if (method === 'folderWorkspace.delete') {
      return okFixture('req_delete', { deleted: true })
    }
    throw new Error(`unexpected ${method}`)
  }
}

function lastJson(log: ReturnType<typeof vi.spyOn>): {
  result?: unknown
  error?: { code: string }
} {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]))
}

function folderMutations(): string[] {
  return callMock.mock.calls
    .map(([method]) => String(method))
    .filter((method) => method.startsWith('folderWorkspace.') || method === 'worktree.set')
}

describe('worktree set and rm on folder workspaces', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('set renames and comments through the folder update and returns the set envelope', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(answerFolder())

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'folder:hub-a',
        '--display-name',
        'Renamed',
        '--comment',
        'triaging',
        '--json'
      ],
      '/tmp'
    )

    expect(callMock).toHaveBeenCalledWith('folderWorkspace.update', {
      folderWorkspaceId: 'hub-a',
      requireUniqueId: true,
      updates: { name: 'Renamed', comment: 'triaging' }
    })
    expect(lastJson(log).result).toEqual({ worktree: FOLDER_RECORD })
  })

  it('rm forgets the folder workspace and reports removed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(answerFolder())

    await main(['worktree', 'rm', '--worktree', 'folder:hub-a', '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledWith('folderWorkspace.delete', {
      folderWorkspaceId: 'hub-a',
      requireUniqueId: true
    })
    expect(callMock).not.toHaveBeenCalledWith('worktree.rm', expect.anything(), expect.anything())
    expect(lastJson(log).result).toEqual({ removed: true })
  })

  it.each([[['set', '--display-name', 'x']], [['rm']]])(
    'an Orca without the unique-id guarantee is refused before any change (%s)',
    async (command) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      callMock.mockImplementation(
        answerFolder({ 'status.get': () => okFixture('req_status', { capabilities: [] }) })
      )

      const [verb, ...rest] = command
      await main(['worktree', verb, '--worktree', 'folder:hub-a', ...rest, '--json'], '/tmp')

      expect(lastJson(log).error?.code).toBe('incompatible_runtime')
      expect(folderMutations()).toEqual([])
    }
  )

  it.each([
    [['rm', '--delete-branch']],
    [['rm', '--run-hooks']],
    [['set', '--no-parent']],
    [['set', '--pr', '5']]
  ])('%s is refused on a folder workspace with no change', async (command) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(answerFolder())

    const [verb, ...rest] = command
    await main(['worktree', verb, '--worktree', 'folder:hub-a', ...rest, '--json'], '/tmp')

    expect(lastJson(log).error?.code).toBe('invalid_argument')
    expect(folderMutations()).toEqual([])
  })

  it('activate refuses a folder workspace without asking the runtime to open it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(answerFolder())

    await main(['worktree', 'activate', '--worktree', 'folder:hub-a', '--json'], '/tmp')

    expect(lastJson(log).error?.code).toBe('invalid_argument')
    expect(callMock).not.toHaveBeenCalledWith('worktree.activate', expect.anything())
  })
})
