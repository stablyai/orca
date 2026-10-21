/**
 * The env-handle path, with NO `--from`.
 *
 * Every other orchestration CLI test passes `--from term_coord` explicitly, so the resolver a real
 * worker actually goes through — `ORCA_TERMINAL_HANDLE` plus `validateEnvHandle` — was never
 * exercised. That is why twelve coordinator verbs could fail for a structured worker while the
 * whole suite stayed green, and why the worker's own preamble (which tells it to run these with no
 * `--from`) failed on its first line.
 */

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
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const STRUCTURED_HANDLE = 'structworker_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/**
 * Every command below is one of the twelve that resolve their sender through
 * `resolveCoordinatorTerminalHandle`. All twelve share ONE resolver and one liveness probe, so the
 * set is sufficient if it covers the distinct shapes that reach it: a read, a mutation, a
 * run-scoped verb, a dispatch verb and a worker-start. A per-verb sweep would pin the argv parsing
 * of twelve handlers and still tell us nothing more about the seam that actually broke.
 */
const SENDER_VERBS: { argv: string[]; method: string }[] = [
  { argv: ['orchestration', 'run-current'], method: 'orchestration.runCurrent' },
  { argv: ['orchestration', 'run-create', '--objective', 'x'], method: 'orchestration.runCreate' },
  { argv: ['orchestration', 'task-list'], method: 'orchestration.taskList' },
  { argv: ['orchestration', 'gate-list'], method: 'orchestration.gateList' },
  { argv: ['orchestration', 'dispatch-show', '--task', 't1'], method: 'orchestration.dispatchShow' }
]

describe('a structured worker running orchestration commands as itself', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  function answerCalls(): void {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'terminal.resolveIdentity') {
        return {
          id: 'req',
          ok: true,
          result: { identity: { handle: STRUCTURED_HANDLE, live: true } },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      return { id: 'req', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
    })
  }

  it.each(SENDER_VERBS)(
    'resolves its own identity for $method with no --from',
    async ({ argv, method }) => {
      // The defect this pins: the sender resolver validated the env handle with `terminal.show`, a
      // PTY verb that misses for a structured worker and answers `terminal_handle_stale`. The pane
      // remint that would have recovered it needs `ORCA_PANE_KEY`, which a structured child
      // deliberately does not carry, so the command died on `no_active_sender_terminal`.
      process.env.ORCA_TERMINAL_HANDLE = STRUCTURED_HANDLE
      answerCalls()
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await expect(main(argv)).resolves.not.toThrow()
      const called = callMock.mock.calls.map((call) => call[0] as string)
      expect(called).toContain(method)
      // Never through `terminal.show`: teaching that verb structured handles would hand every
      // public terminal verb something that looks writable and is not.
      expect(called).not.toContain('terminal.show')
    }
  )

  it('sends the structured handle as the sender, not a guessed sibling', async () => {
    process.env.ORCA_TERMINAL_HANDLE = STRUCTURED_HANDLE
    answerCalls()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['orchestration', 'run-create', '--objective', 'x'])
    const create = callMock.mock.calls.find((call) => call[0] === 'orchestration.runCreate')
    expect((create?.[1] as { from?: string } | undefined)?.from).toBe(STRUCTURED_HANDLE)
  })

  it('still refuses a handle the runtime reports dead, with no pane key to remint from', async () => {
    // The invariant the fix must not break: a stale `ORCA_TERMINAL_HANDLE` in a long-lived shell
    // must keep failing rather than being baked into a coordinator preamble.
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    callMock.mockImplementation(async (method: string) => {
      if (method === 'terminal.resolveIdentity') {
        return {
          id: 'req',
          ok: true,
          result: { identity: { handle: 'term_stale', live: false } },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      return { id: 'req', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    await main(['orchestration', 'run-create', '--objective', 'x'])
    expect(process.exitCode).toBe(1)
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(
      /no_active_sender_terminal|sender terminal/i
    )
    expect(callMock.mock.calls.map((call) => call[0])).not.toContain('orchestration.runCreate')
    process.exitCode = priorExitCode
    errorSpy.mockRestore()
  })
})
