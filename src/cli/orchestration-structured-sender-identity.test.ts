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

// Cover distinct handler shapes that share sender resolution and liveness checks.
const SENDER_VERBS: {
  argv: string[]
  method: string
  senderField: 'from' | 'callerTerminalHandle'
}[] = [
  {
    argv: ['orchestration', 'run-current'],
    method: 'orchestration.runCurrent',
    senderField: 'from'
  },
  {
    argv: ['orchestration', 'run-create', '--objective', 'x'],
    method: 'orchestration.runCreate',
    senderField: 'from'
  },
  {
    argv: ['orchestration', 'task-list'],
    method: 'orchestration.taskList',
    senderField: 'callerTerminalHandle'
  },
  { argv: ['orchestration', 'gate-list'], method: 'orchestration.gateList', senderField: 'from' },
  {
    argv: ['orchestration', 'dispatch-show', '--task', 't1', '--preamble'],
    method: 'orchestration.dispatchShow',
    senderField: 'from'
  }
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
      const result =
        method === 'orchestration.runCreate'
          ? { run: { id: 'run-1', objective: 'x' } }
          : method === 'orchestration.runCurrent'
            ? { run: null }
            : method === 'orchestration.taskList'
              ? { tasks: [], count: 0 }
              : method === 'orchestration.gateList'
                ? { gates: [], count: 0 }
                : { dispatch: null, preamble: 'preview' }
      return { id: 'req', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
    })
  }

  it.each(SENDER_VERBS)(
    'resolves its own identity for $method with no --from',
    async ({ argv, method, senderField }) => {
      process.env.ORCA_TERMINAL_HANDLE = STRUCTURED_HANDLE
      answerCalls()
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      await expect(main(argv)).resolves.not.toThrow()
      expect(process.exitCode).toBe(priorExitCode)
      const called = callMock.mock.calls.map((call) => call[0] as string)
      expect(callMock).toHaveBeenCalledWith('terminal.resolveIdentity', {
        terminal: STRUCTURED_HANDLE
      })
      expect(callMock).toHaveBeenCalledWith(
        method,
        expect.objectContaining({ [senderField]: STRUCTURED_HANDLE })
      )
      // Structured workers lack writable PTYs; terminal.show must not validate them.
      expect(called).not.toContain('terminal.show')
    }
  )

  it('still refuses a handle the runtime reports dead, with no pane key to remint from', async () => {
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
