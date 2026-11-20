import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

vi.mock('../runtime/pairing/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('../index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from '../index'
import { useWorktreeAwarenessEnvironment } from '../index-test-harness'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

function useCliEntryEnvironment(): void {
  const priorExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = priorExitCode
    vi.unstubAllEnvs()
  })
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
}

describe('orca cli worktree awareness', () => {
  useCliEntryEnvironment()

  it("refuses an agent session's caller flag naming another caller before any request", async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'f7a1c0de-1111-4222-8333-444455556666')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['orchestration', 'check', '--terminal', 'term_sibling', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
  })
})

describe('orchestration inbox --run', () => {
  useCliEntryEnvironment()

  it('sends --run and refuses rows from other Runs that an older server returns', async () => {
    callMock.mockResolvedValue(
      okFixture('req_inbox', {
        messages: [
          { id: 'msg_mine', run_id: 'run_x', from_handle: 'a', subject: 'mine' },
          { id: 'msg_theirs', run_id: 'run_other', from_handle: 'b', subject: 'theirs' }
        ],
        count: 2
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['orchestration', 'inbox', '--run', 'run_x', '--full', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.inbox',
      expect.objectContaining({ run: 'run_x' })
    )
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'incompatible_runtime' }
    })
  })

  it('refuses an empty --run instead of listing every mailbox', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['orchestration', 'inbox', '--run', '', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
