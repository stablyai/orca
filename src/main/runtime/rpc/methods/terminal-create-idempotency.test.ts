import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeMachineName } from '../../runtime-machine-name'
import { TERMINAL_METHODS } from './terminal'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

beforeEach(() => {
  vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})
describe('terminal.create RPC idempotency', () => {
  it('routes a host request without calling the local create or deduplication path', async () => {
    const terminal = { handle: 'remote-handle', worktreeId: 'remote-worktree', title: null }
    const runtime = new OrcaRuntimeService()
    const createTerminalOnHost = vi
      .spyOn(runtime, 'createTerminalOnHost')
      .mockResolvedValue(terminal)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal)
    const dedupeTerminalCreate = vi
      .spyOn(runtime, 'dedupeTerminalCreate')
      .mockResolvedValue(terminal)
    const method = eraseRpcMethods(TERMINAL_METHODS).find(
      (entry) => entry.name === 'terminal.create'
    )
    if (!method) {
      throw new Error('terminal.create method missing')
    }
    const params = {
      worktree: 'id:local-worktree',
      executionHostId: 'runtime:E',
      projectHostSetupId: 'setup'
    }
    const context: RpcContext = { runtime, clientKind: 'runtime' }
    const result = await method.handler(params, context, vi.fn())
    expect(result).toEqual({ terminal })
    expect(createTerminalOnHost).toHaveBeenCalledWith(params)
    expect(createTerminal).not.toHaveBeenCalled()
    expect(dedupeTerminalCreate).not.toHaveBeenCalled()
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses paired %s host forwarding before any runtime creation',
    async (clientKind) => {
      const terminal = { handle: 'remote-handle', worktreeId: 'remote-worktree', title: null }
      const runtime = new OrcaRuntimeService()
      const createTerminalOnHost = vi
        .spyOn(runtime, 'createTerminalOnHost')
        .mockResolvedValue(terminal)
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal)
      const dedupeTerminalCreate = vi
        .spyOn(runtime, 'dedupeTerminalCreate')
        .mockResolvedValue(terminal)
      const method = eraseRpcMethods(TERMINAL_METHODS).find(
        (entry) => entry.name === 'terminal.create'
      )
      if (!method) {
        throw new Error('terminal.create method missing')
      }
      const params = {
        worktree: 'id:local-worktree',
        executionHostId: 'runtime:E',
        projectHostSetupId: 'setup'
      }
      const context: RpcContext = { runtime, pairedDeviceId: 'device-a', clientKind }
      await expect(method.handler(params, context, vi.fn())).rejects.toMatchObject({
        code: 'host_kind_not_supported_yet',
        data: { executionHostId: 'runtime:E', projectHostSetupId: 'setup' }
      })
      expect(createTerminalOnHost).not.toHaveBeenCalled()
      expect(createTerminal).not.toHaveBeenCalled()
      expect(dedupeTerminalCreate).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'local'] as const)(
    'preserves local mutation scope with host %s',
    async (executionHostId) => {
      const terminal = { handle: 'terminal-1', worktreeId: 'worktree-1', title: null }
      const runtime = new OrcaRuntimeService()
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal)
      const dedupeTerminalCreate = vi
        .spyOn(runtime, 'dedupeTerminalCreate')
        .mockImplementation(
          async (_clientIdentity, _worktree, _mutationId, _reconcileExisting, run) =>
            run('id:worktree-1', 'term_stable')
        )
      const method = eraseRpcMethods(TERMINAL_METHODS).find(
        (candidate) => candidate.name === 'terminal.create'
      )
      if (!method) {
        throw new Error('terminal.create method missing')
      }

      const context: RpcContext = { runtime, pairedDeviceId: 'device-a', clientId: 'bearer-token' }
      const result = await method.handler(
        {
          worktree: 'id:worktree-1',
          executionHostId,
          clientMutationId: 'mutation-1',
          command: 'pwsh',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-1',
            transcriptPath: 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'
          }
        },
        context,
        vi.fn()
      )

      expect(dedupeTerminalCreate).toHaveBeenCalledWith(
        'device-a',
        'id:worktree-1',
        'mutation-1',
        false,
        expect.any(Function)
      )
      expect(createTerminal).toHaveBeenCalledWith(
        'id:worktree-1',
        expect.objectContaining({
          command: 'pwsh',
          preAllocatedHandle: 'term_stable',
          resumeProviderSession: {
            key: 'session_id',
            id: 'session-1',
            transcriptPath: 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'
          }
        })
      )
      expect(result).toEqual({ terminal })
    }
  )

  it.each([
    { clientKind: 'mobile', executionHostId: undefined },
    { clientKind: 'runtime', executionHostId: undefined },
    { clientKind: 'mobile', executionHostId: 'local' },
    { clientKind: 'runtime', executionHostId: 'local' }
  ] as const)(
    'keeps paired local host %s creates in the existing background path',
    async ({ clientKind, executionHostId }) => {
      const terminal = { handle: 'terminal-focused', worktreeId: 'worktree-1', title: null }
      const runtime = new OrcaRuntimeService()
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal)
      vi.spyOn(runtime, 'dedupeTerminalCreate').mockImplementation(
        async (_clientIdentity, _worktree, _mutationId, _reconcileExisting, run) =>
          run('id:worktree-1', undefined)
      )
      const method = eraseRpcMethods(TERMINAL_METHODS).find(
        (candidate) => candidate.name === 'terminal.create'
      )
      if (!method) {
        throw new Error('terminal.create method missing')
      }

      const context: RpcContext = { runtime, pairedDeviceId: 'device-b', clientKind }
      await method.handler(
        {
          worktree: 'id:worktree-1',
          executionHostId,
          presentation: 'focused',
          focus: true,
          activate: true
        },
        context,
        vi.fn()
      )

      expect(createTerminal).toHaveBeenCalledWith(
        'id:worktree-1',
        expect.objectContaining({
          presentation: 'background',
          focus: false,
          activate: false
        })
      )
    }
  )

  it('preserves focus for an in-process caller', async () => {
    const createTerminal = vi.fn(async () => ({ handle: 'terminal-host' }))
    const dedupeTerminalCreate = vi.fn(
      async (
        _owner: string,
        _worktree: string | undefined,
        _mutationId: string | undefined,
        _reconcile: boolean,
        run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
      ) => run('id:worktree-1', undefined)
    )
    const method = eraseRpcMethods(TERMINAL_METHODS).find(
      (candidate) => candidate.name === 'terminal.create'
    )
    if (!method) {
      throw new Error('terminal.create method missing')
    }

    await method.handler(
      { worktree: 'id:worktree-1', presentation: 'focused', focus: true, activate: true },
      {
        runtime: { createTerminal, dedupeTerminalCreate }
      } as unknown as RpcContext,
      vi.fn()
    )

    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({ presentation: 'focused', focus: true, activate: true })
    )
  })
})
