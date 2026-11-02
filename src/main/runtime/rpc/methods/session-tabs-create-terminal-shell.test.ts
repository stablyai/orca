import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-runtime-capabilities'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'session.tabs.createTerminal', params }
}

function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls these two members.
  return {
    getRuntimeId: () => 'test-runtime',
    createMobileSessionTerminal: vi.fn().mockResolvedValue({
      tab: { type: 'terminal', id: 'tab-1::leaf-1' },
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1
    })
  } as unknown as OrcaRuntimeService
}

describe('session.tabs.createTerminal shell selection', () => {
  it('advertises shell selection so clients stop typing the shell into the default one', () => {
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY)
  })

  it('creates the requested shell instead of a startup command', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1', shell: 'Cmd' }))

    expect(response.ok).toBe(true)
    const opts = vi.mocked(runtime.createMobileSessionTerminal).mock.calls[0]?.[1]
    expect(opts).toMatchObject({ shellOverride: 'cmd.exe' })
    expect(opts?.command).toBeUndefined()
  })

  it('omits the override when no shell is requested', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1' }))

    const opts = vi.mocked(runtime.createMobileSessionTerminal).mock.calls[0]?.[1]
    expect(opts).not.toHaveProperty('shellOverride')
  })

  it('refuses a shell pick combined with an agent launch, whose plan picks its own shell', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', shell: 'cmd.exe', agent: 'claude' })
    )

    expect(response.ok).toBe(false)
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('refuses a shell outside the Windows allowlist before creating a terminal', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(makeRequest({ worktree: 'id:wt-1', shell: 'zsh' }))

    expect(response.ok).toBe(false)
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })
})
