import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'

import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktreesStrict: async () => [
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

function makeRuntime(overrides: Partial<OrcaRuntimeService>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cases call only the runtime members they override.
  return {
    getRuntimeId: () => 'test-runtime',
    isTerminalRunningAgent: vi.fn().mockResolvedValue(false),
    ...overrides
  } as OrcaRuntimeService
}

describe('terminal agent prompt send RPC', () => {
  it.each([false, true])(
    'refuses desktop input after late phone takeover (prompt=%s)',
    async (agentPrompt) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      const selecting = Promise.withResolvers<void>()
      const release = Promise.withResolvers<boolean>()
      vi.spyOn(runtime, 'isTerminalRunningSettledPromptAgent').mockImplementation(() => {
        selecting.resolve()
        return release.promise
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const sending = dispatcher.dispatch(
        makeRequest({
          terminal: handle,
          text: 'first',
          enter: true,
          agentPrompt: true,
          client: { id: 'desktop-1', type: 'desktop' }
        }),
        { caller: { kind: 'paired-device', deviceId: 'desktop-pair' } }
      )
      await selecting.promise
      await runtime.handleMobileSubscribe('pty-prompt', 'phone-A', { cols: 45, rows: 20 })
      release.resolve(agentPrompt)
      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { send: { handle, accepted: false, bytesWritten: 0 } }
      })
      expect(writes).toEqual([])
    }
  )

  // Admission is not settlement support: an agent the runtime knows still goes through the host's
  // one operation, with a receipt of accepted input instead of turn observation.
  it('takes a prompt to an agent without turn settlement through the host operation', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 4
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'yes',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'terminal-1',
      'yes',
      expect.objectContaining({ inputKind: 'driving', acceptQueued: true, observationTimeoutMs: 0 })
    )
  })
})
