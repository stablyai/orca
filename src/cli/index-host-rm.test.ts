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
import { okFixture } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

const KEPT = { id: 'ssh-1783599077486-fyasux', label: 'trader-local' }
const STALE = { id: 'ssh-1783600000000-abcdef', label: 'ticket-vm-42' }

/** Serve the target list and record removals, as the runtime's ssh RPC methods do. */
function fakeSshRuntime(): { removed: string[] } {
  const removed: string[] = []
  callMock.mockImplementation(async (method: string, params?: { targetId: string }) => {
    if (method === 'ssh.listTargetSummaries') {
      return okFixture('req_ssh_targets', { targets: [KEPT, STALE] })
    }
    if (method === 'ssh.removeTarget' && params) {
      removed.push(params.targetId)
      return okFixture('req_ssh_remove', { removed: true })
    }
    throw new Error(`unexpected call ${method}`)
  })
  return { removed }
}

function printedJson(logSpy: { mock: { calls: unknown[][] } }): {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
} {
  return JSON.parse(String(logSpy.mock.calls[0]?.[0]))
}

describe('orca host rm', () => {
  const priorExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = priorExitCode
  })
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('removes only the named SSH target through ssh.removeTarget and prints it', async () => {
    const runtime = fakeSshRuntime()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'rm', '--host', `ssh:${STALE.id}`, '--json'], '/tmp/repo')

    expect(runtime.removed).toEqual([STALE.id])
    expect(printedJson(logSpy)).toMatchObject({
      ok: true,
      result: { removed: { kind: 'ssh', name: STALE.label, id: STALE.id } },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it.each([
    ['local', 'This machine is always listed'],
    ['this machine', 'This machine is always listed'],
    ['runtime:env-m4air', 'orca environment rm'],
    ['m4air', '--host ssh:<target-id>']
  ])('refuses --host %s before it reaches the runtime', async (host, nextStep) => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const runtime = fakeSshRuntime()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'rm', '--host', host, '--json'], '/tmp/repo')

    const printed = printedJson(logSpy)
    expect(printed.ok).toBe(false)
    expect(printed.error?.code).toBe('invalid_argument')
    expect(printed.error?.message).toContain('removes saved SSH targets only')
    expect(JSON.stringify(printed)).toContain(nextStep)
    expect(runtime.removed).toEqual([])
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['environment', 'm4air'],
    ['pairing-code', 'orca://pair?code=x']
  ])('refuses --%s rather than removing the target on another machine', async (flag, value) => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const runtime = fakeSshRuntime()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['host', 'rm', '--host', `ssh:${STALE.id}`, `--${flag}`, value, '--json'],
      '/tmp/repo'
    )

    const printed = printedJson(logSpy)
    expect(printed.error?.code).toBe('invalid_argument')
    expect(printed.error?.message).toContain(`\`--${flag}\` does not retarget \`orca host rm\``)
    expect(runtime.removed).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('refuses an id the runtime does not have, and does not match a label', async () => {
    const runtime = fakeSshRuntime()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'rm', '--host', `ssh:${STALE.label}`, '--json'], '/tmp/repo')

    const printed = printedJson(logSpy)
    expect(printed.error?.code).toBe('invalid_argument')
    expect(printed.error?.message).toContain(`Unknown SSH target in --host ssh:${STALE.label}`)
    expect(runtime.removed).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('reports a stopped runtime instead of an unknown target', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'Orca is not running'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'rm', '--host', `ssh:${STALE.id}`, '--json'], '/tmp/repo')

    expect(printedJson(logSpy).error?.code).toBe('runtime_unavailable')
    expect(callMock).not.toHaveBeenCalledWith('ssh.removeTarget', expect.anything())
    expect(process.exitCode).toBe(1)
  })
})
