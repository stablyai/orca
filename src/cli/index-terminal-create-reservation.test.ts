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
import { RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const RESERVATION_ARGS = [
  '--idempotency-key',
  'key-1',
  '--reservation-id',
  'res-1',
  '--reservation-session',
  'session-1',
  '--ownership-generation',
  '0'
]

const RESERVATION_PARAM = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'terminal',
  ownershipGeneration: 0
}

const CREATE_ARGS = ['terminal', 'create', '--worktree', 'id:repo-1::/tmp/repo/child']

function statusFixture(capabilities: string[]) {
  return okFixture('req_status', { runtimeId: 'runtime-1', capabilities })
}

function createdTerminalFixture(reservation: unknown) {
  return okFixture('req_create', {
    terminal: {
      handle: 'term_abc',
      worktreeId: 'repo-1::/tmp/repo/child',
      title: null,
      ...(reservation === undefined ? {} : { reservation })
    }
  })
}

function silenceOutput(): void {
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('orca terminal create reservation binding', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends the binding and asks the host to reconcile an existing reserved terminal', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdTerminalFixture({ ...RESERVATION_PARAM, boundAt: 42 })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ reservation: RESERVATION_PARAM, reconcileExisting: true })
    )
    expect(process.exitCode).toBeFalsy()
  })

  it('refuses before creating anything when the host does not advertise the capability', async () => {
    queueFixtures(callMock, statusFixture(['terminal.create-idempotency.v2']))
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).not.toHaveBeenCalledWith('terminal.create', expect.anything())
    expect(process.exitCode).toBe(1)
  })

  it('refuses a create whose reply carries no binding back', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdTerminalFixture(undefined)
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(process.exitCode).toBe(1)
  })

  it('refuses a create whose reply changes an immutable binding field', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdTerminalFixture({ ...RESERVATION_PARAM, ownershipGeneration: 1, boundAt: 42 })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(process.exitCode).toBe(1)
  })

  it('leaves an unreserved create untouched', async () => {
    queueFixtures(callMock, createdTerminalFixture(undefined))
    silenceOutput()

    await main([...CREATE_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'terminal.create',
      expect.not.objectContaining({ reservation: expect.anything() })
    )
  })
})
