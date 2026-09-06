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
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const RESERVATION_ARGS = [
  '--idempotency-key',
  'key-1',
  '--reservation-id',
  'res-1',
  '--reservation-session',
  'session-1',
  '--ownership-generation',
  '7',
  '--reservation-issuer',
  'openloop'
]

const RESERVATION_PARAM = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'worktree',
  ownershipGeneration: 7,
  issuer: 'openloop'
}

function statusFixture(capabilities: string[]) {
  return okFixture('req_status', { runtimeId: 'runtime-1', capabilities })
}

function createdWorktreeFixture(reservation: unknown) {
  return okFixture('req_create', {
    worktree: {
      ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
      ...(reservation === undefined ? {} : { reservation })
    },
    lineage: null,
    warnings: []
  })
}

function silenceOutput(): void {
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** --no-parent with an explicit --repo keeps the run free of cwd-inference RPCs, so every
 *  assertion below is about the reservation calls and nothing else. */
const CREATE_ARGS = ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent']

describe('orca worktree create reservation binding', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends the caller-generated binding after the host advertises support', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdWorktreeFixture({ ...RESERVATION_PARAM, boundAt: 42 })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ reservation: RESERVATION_PARAM })
    )
    expect(process.exitCode).toBeFalsy()
  })

  it('refuses before creating anything when the host does not advertise the capability', async () => {
    queueFixtures(callMock, statusFixture(['worktree.create-idempotency.v1']))
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(process.exitCode).toBe(1)
  })

  it('refuses a create whose reply carries no binding back', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdWorktreeFixture(undefined)
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(process.exitCode).toBe(1)
  })

  it('refuses a create whose reply changes an immutable binding field', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdWorktreeFixture({ ...RESERVATION_PARAM, sessionId: 'wrong-session', boundAt: 42 })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'incompatible_runtime' }
    })
    expect(process.exitCode).toBe(1)
  })

  it('preserves a provider reservation conflict through the public JSON contract', async () => {
    callMock.mockResolvedValueOnce(
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY])
    )
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: {
          code: 'reservation_conflict',
          message: 'Reservation keys are single-use.',
          data: { resourceKind: 'worktree', resourceId: 'worktree-1' }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'reservation_conflict',
        data: { resourceKind: 'worktree', resourceId: 'worktree-1' }
      }
    })
    expect(process.exitCode).toBe(1)
  })

  it('sends no reservation and probes no capability without the flags', async () => {
    queueFixtures(callMock, createdWorktreeFixture(undefined))
    silenceOutput()

    await main([...CREATE_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.not.objectContaining({ reservation: expect.anything() })
    )
  })

  it('refuses a partial binding rather than creating an unattributable workspace', async () => {
    silenceOutput()

    await main([...CREATE_ARGS, '--idempotency-key', 'key-1', '--json'], '/tmp/elsewhere')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('refuses an ownership generation that cannot round-trip as a safe integer', async () => {
    silenceOutput()
    const unsafe = RESERVATION_ARGS.map((value, index) =>
      RESERVATION_ARGS[index - 1] === '--ownership-generation' ? '9007199254740993' : value
    )

    await main([...CREATE_ARGS, ...unsafe, '--json'], '/tmp/elsewhere')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('propagates cwd selector infrastructure failures instead of reporting a missing repo', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'runtime transport exploded')
    )
    silenceOutput()

    await main(['worktree', 'create', '--name', 'child', '--json'], '/tmp/managed-or-not')

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(output).toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'runtime transport exploded' }
    })
    expect(output.error.message).not.toContain('Missing repo selector')
    expect(process.exitCode).toBe(1)
  })

  it('does not require remote cwd lineage when an explicit repo supplies the create target', async () => {
    process.env.ORCA_PAIRING_CODE = 'remote-runtime'
    callMock.mockResolvedValueOnce(createdWorktreeFixture(undefined))
    silenceOutput()

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/remote-only/path'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      displayName: 'child',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
    expect(process.exitCode).toBeFalsy()
  })

  it('does not hide infrastructure failures during optional cwd lineage lookup', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'runtime transport exploded')
    )
    silenceOutput()

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/managed-or-not'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(process.exitCode).toBe(1)
  })
})
