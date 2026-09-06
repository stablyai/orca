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
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca terminal tab title JSON', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('round-trips create --title into list --json independently of the live title', async () => {
    const userTitle = 'Codex: skills review'
    let terminal: { handle: string; title: string; tabTitle: string } | undefined
    callMock.mockImplementation(async (method, params) => {
      if (method === 'terminal.create') {
        terminal = { handle: 'term_worker', title: params.title, tabTitle: params.title }
        return okFixture('req_create', { terminal })
      }
      if (method === 'terminal.list') {
        return okFixture('req_list', {
          terminals: [{ ...terminal, title: '⠸ orchestration-v3' }],
          totalCount: 1,
          truncated: false
        })
      }
      throw new Error(`Unexpected RPC: ${method}`)
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        userTitle,
        '--json'
      ],
      '/tmp/repo'
    )
    await main(['terminal', 'list', '--worktree', 'path:/tmp/repo/feature', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ title: userTitle })
    )
    const created = JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.terminal
    const listed = JSON.parse(String(logSpy.mock.calls[1]?.[0])).result.terminals[0]
    expect(created.tabTitle).toBe(userTitle)
    expect(listed).toMatchObject({
      handle: created.handle,
      tabTitle: userTitle,
      title: '⠸ orchestration-v3'
    })
  })

  it('tolerates terminal list JSON from an older host without tabTitle', async () => {
    queueFixtures(
      callMock,
      okFixture('req_list', {
        terminals: [{ handle: 'term_old', title: 'legacy shell' }],
        totalCount: 1,
        truncated: false
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'path:/tmp/repo/feature', '--json'], '/tmp/repo')

    const listed = JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.terminals[0]
    expect(listed).toEqual({ handle: 'term_old', title: 'legacy shell' })
  })
})
