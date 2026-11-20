import { afterEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('./runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture } from './runtime/fixtures/runtime-rpc-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const SIGNED_IN = { state: 'signed-in', email: 'a@example.test', storage: { kind: 'os-keychain' } }

function fakeLocalHost(): void {
  callMock.mockImplementation(async (method: string) => {
    switch (method) {
      case 'status.get':
        return okFixture('req', { capabilities: ['orca-account.server-sign-in.v1'] })
      case 'orcaAccount.status':
        return okFixture('req', SIGNED_IN)
      default:
        throw new Error(`unexpected call ${method}`)
    }
  })
}

describe('`orca auth` stays on this host', () => {
  const priorExitCode = process.exitCode
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

  it('reads account status locally with ambient remote selectors', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'somewhere-else')
    vi.stubEnv('ORCA_PAIRING_CODE', 'primary-code')
    vi.stubEnv('ORCA_REMOTE_PAIRING', 'legacy-code')
    fakeLocalHost()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()

    await main(['auth', 'status', '--json'], '/tmp/repo')

    expect(runtimeClientConstructorMock).toHaveBeenCalledExactlyOnceWith(null, null)
    expect(callMock).toHaveBeenCalledWith('orcaAccount.status')
  })

  it.each(['--environment', '--pairing-code'])(
    'refuses an explicit %s before any account call',
    async (flag) => {
      fakeLocalHost()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['auth', 'logout', flag, 'other', '--json'], '/tmp/repo')

      expect(callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    }
  )
})
