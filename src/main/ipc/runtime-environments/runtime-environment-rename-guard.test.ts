import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, renameEnvironmentMock, resolveEnvironmentMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  renameEnvironmentMock: vi.fn(),
  resolveEnvironmentMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

vi.mock('../../runtime/client/navigation/desktop-chat-creation-history', () => ({
  desktopChatCreationHistory: vi.fn(() => ({ sessionIds: () => [] }))
}))

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: vi.fn(() => []),
  removeEnvironment: vi.fn(),
  renameEnvironment: renameEnvironmentMock,
  resolveEnvironment: resolveEnvironmentMock
}))

import { registerRuntimeEnvironmentConnectivityHandlers } from './runtime-environment-connectivity-handlers'

const environment = { id: 'environment-a', name: 'desk', runtimeId: 'runtime-a', endpoints: [] }

function renameHandler(): (event: unknown, args: { selector: string; name: string }) => unknown {
  const call = handleMock.mock.calls.find(([channel]) => channel === 'runtimeEnvironments:rename')
  expect(call).toBeTruthy()
  return call![1]
}

beforeEach(() => {
  handleMock.mockReset()
  resolveEnvironmentMock.mockReset().mockReturnValue(environment)
  renameEnvironmentMock.mockReset().mockReturnValue({ name: 'desk-2', updatedAt: 2 })
  registerRuntimeEnvironmentConnectivityHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rename reads no store members on the tested paths.
    store: {} as never,
    getUserDataPath: () => '/tmp/orca-user-data',
    invalidateTransport: () => Promise.resolve()
  })
})

describe('runtime environment rename argument guard', () => {
  it('rejects a non-string name before touching the store', () => {
    expect(() => renameHandler()(null, { selector: 'environment-a', name: 42 as never })).toThrow(
      'Renaming a server requires a name.'
    )
    expect(resolveEnvironmentMock).not.toHaveBeenCalled()
    expect(renameEnvironmentMock).not.toHaveBeenCalled()
  })

  it('passes a string name through to the store rename', () => {
    expect(
      renameHandler()(null, { selector: 'environment-a', name: 'desk-2' })
    ).toMatchObject({ environment: { name: 'desk-2' } })
    expect(renameEnvironmentMock).toHaveBeenCalledWith('/tmp/orca-user-data', 'environment-a', {
      name: 'desk-2'
    })
  })
})
