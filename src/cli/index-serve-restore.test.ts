import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca serve restore resume', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  beforeEach(() => {
    runtimeClientConstructorMock.mockClear()
  })

  it('asks the local Orca to resume and never starts a server', async () => {
    process.env.ORCA_ENVIRONMENT = 'paired-env'
    callMock.mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: {
        automaticWork: {
          admission: 'enforce',
          mode: { kind: 'normal' },
          cleared: { kind: 'paused', reason: 'unclean_host_death', since: 0 }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'restore', 'resume'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(callMock.mock.calls).toEqual([['runtime.automaticWork.resume']])
    expect(runtimeClientConstructorMock.mock.calls).toEqual([[null, null]])
    expect(logSpy.mock.calls).toEqual([
      [
        'Automatic restores resumed. They were paused at 1970-01-01T00:00:00.000Z because the terminal host stopped unexpectedly.'
      ]
    ])
  })

  it('says so when nothing was paused, and when the host has no gate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockResolvedValueOnce({
      id: 'rpc',
      ok: true,
      result: { automaticWork: { admission: 'enforce', mode: { kind: 'normal' }, cleared: null } },
      _meta: { runtimeId: 'runtime-1' }
    })
    await main(['serve', 'restore', 'resume'], '/tmp/repo')
    callMock.mockResolvedValueOnce({
      id: 'rpc',
      ok: true,
      result: { automaticWork: null },
      _meta: { runtimeId: 'runtime-1' }
    })
    await main(['serve', 'restore', 'resume'], '/tmp/repo')

    expect(callMock.mock.calls).toEqual([
      ['runtime.automaticWork.resume'],
      ['runtime.automaticWork.resume']
    ])
    expect(logSpy.mock.calls).toEqual([
      ['Automatic restores were not paused; nothing to resume.'],
      ['This host has no automatic-restore gate to resume (its terminal host predates it).']
    ])
  })

  it('explains a terminal host that predates the command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockResolvedValueOnce({
      id: 'rpc',
      ok: true,
      result: { automaticWork: null, terminalHostPredatesResume: true },
      _meta: { runtimeId: 'runtime-1' }
    })
    await main(['serve', 'restore', 'resume'], '/tmp/repo')
    expect(callMock.mock.calls).toEqual([['runtime.automaticWork.resume']])
    expect(logSpy.mock.calls).toEqual([
      [
        'The terminal host running now predates this command, so it cannot clear its pause. Run this again after the terminal host restarts. Until then, opening a sleeping terminal still resumes it.'
      ]
    ])
  })
})
