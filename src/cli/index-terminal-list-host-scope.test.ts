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

const REMOTE_ROW = {
  handle: 'term_remote',
  ptyId: 'ssh:box-1@@pty-7',
  worktreeId: 'repo-ssh::/remote/wt',
  worktreePath: '/remote/wt',
  branch: 'main',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  title: 'worker',
  connected: true,
  writable: true,
  lastOutputAt: null,
  preview: '',
  executionHostId: 'ssh:box-1'
}

describe('orca terminal list host scope', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('keeps the execution host and scope in --json output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [REMOTE_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--json'], '/tmp/repo')

    expect(callMock.mock.calls).toEqual([
      ['terminal.list', { worktree: undefined, limit: undefined, includeVisualLayouts: false }]
    ])

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.terminals[0].executionHostId).toBe('ssh:box-1')
    expect(printed.result.hostScope).toEqual({
      hostIds: ['ssh:box-1'],
      omittedHostIds: ['local'],
      // These hosts are reached through the answering runtime; listing takes no --host flag.
      omittedHostSelectors: [{ hostId: 'local', selector: null }]
    })
  })

  it('prints the execution host and scope in human output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [REMOTE_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list'], '/tmp/repo')

    expect(callMock.mock.calls).toEqual([
      ['terminal.list', { worktree: undefined, limit: undefined, includeVisualLayouts: true }]
    ])

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toBe(
      'term_remote  worker  connected  host=ssh:box-1  /remote/wt\npreview: <empty>\n\nscope: ssh:box-1 — not covered: local (reached through this runtime; no flag selects it)'
    )
  })

  it('does not claim a local scope when the host never reported one', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', { terminals: [], totalCount: 0, truncated: false })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list'], '/tmp/repo')

    expect(callMock.mock.calls).toEqual([
      ['terminal.list', { worktree: undefined, limit: undefined, includeVisualLayouts: true }]
    ])

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toBe(
      'No terminals listed.\nscope: unverifiable — this host does not report which hosts it lists'
    )
  })
})
