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
import { RuntimeRpcFailureError } from './runtime/types'
import { okFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const FOLDER_RECORD = { id: 'folder:hub-a', path: '/work/hub' }

function notFound(): never {
  throw new RuntimeRpcFailureError({
    id: 'req_missing',
    ok: false,
    error: { code: 'selector_not_found', message: 'selector_not_found' },
    _meta: { runtimeId: 'runtime-1' }
  })
}

/** A runtime that matches folders by path only when the request opts in, or an older one that never does. */
function answer(folderMatching: boolean) {
  return async (method: string, params?: Record<string, unknown>) => {
    if (method === 'worktree.show') {
      return folderMatching && params?.matchFolderWorkspaces === true
        ? okFixture('req_show', { worktree: FOLDER_RECORD })
        : notFound()
    }
    if (method === 'status.get') {
      return okFixture('req_status', {
        capabilities: folderMatching ? ['workspace-selector.folder-match.v1'] : []
      })
    }
    if (method === 'folderWorkspace.list') {
      return okFixture('req_folders', {
        folderWorkspaces: [{ id: 'hub-a', folderPath: '/work/hub' }]
      })
    }
    return okFixture('req_command', {
      ports: [],
      terminal: { handle: 'term_1', worktreeId: FOLDER_RECORD.id, title: null },
      opened: true,
      kind: 'text',
      relativePath: 'README.md'
    })
  }
}

describe('path: selectors on folder workspaces', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    [['terminal', 'create'], 'terminal.create'],
    [['file', 'open', 'README.md'], 'files.open']
  ])('%s reaches the folder workspace', async (command, method) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(answer(true))

    await main([...command, '--worktree', 'path:/work/hub', '--json'], '/tmp')

    expect(callMock).toHaveBeenCalledWith(
      method,
      expect.objectContaining({ worktree: 'folder:hub-a' })
    )
  })

  it.each([
    [true, 'folder:hub-a'],
    [false, 'id:folder:hub-a']
  ])(
    'ports --all scans the folder workspace (runtime matches folders: %s)',
    async (folderMatching, scanned) => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      callMock.mockImplementation(answer(folderMatching))

      await main(['ports', '--all', '--worktree', 'path:/work/hub', '--json'], '/tmp')

      expect(callMock).toHaveBeenCalledWith('workspacePorts.scanHost', { worktree: scanned })
    }
  )

  it('sends a path:/name: parent to the runtime parent resolver as typed, with its ambiguity code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const choices = {
      selector: 'name:Hub',
      candidates: [
        { kind: 'folder workspace', hostId: 'local', path: '/work/hub', selector: 'folder:hub-a' },
        { kind: 'folder workspace', hostId: 'local', path: '/work/hub', selector: 'folder:hub-b' }
      ],
      nextSteps: ['Run `orca worktree ps --json` to compare the choices.']
    }
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.set') {
        throw new RuntimeRpcFailureError({
          id: 'req_set',
          ok: false,
          error: {
            code: 'LINEAGE_PARENT_AMBIGUOUS',
            message: 'More than one workspace matches "name:Hub".',
            data: choices
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      return okFixture('req_other', {})
    })

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/c', '--parent-worktree', 'name:Hub', '--json'],
      '/tmp'
    )

    expect(callMock).not.toHaveBeenCalledWith('worktree.show', expect.anything())
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({ parentWorktree: 'name:Hub', matchFolderWorkspaces: true })
    )
    const { error } = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
    expect(error).toMatchObject({ code: 'LINEAGE_PARENT_AMBIGUOUS', data: choices })
  })
})
