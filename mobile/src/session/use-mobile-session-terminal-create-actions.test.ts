import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn()
}))

function clientReturning(...responses: unknown[]): RpcClient {
  let responseIndex = 0
  return {
    sendRequest: vi.fn(async () => responses[responseIndex++])
  } as unknown as RpcClient
}

function terminalCreateResponse() {
  return {
    ok: true,
    result: {
      tab: {
        type: 'terminal',
        id: 'terminal-tab-1',
        title: 'Codex',
        terminal: 'terminal-1',
        isActive: true
      }
    }
  }
}

function createScope(client: RpcClient) {
  return {
    worktreeId: 'workspace-1',
    client,
    hostCapabilities: [],
    connState: 'connected',
    setTerminals: vi.fn(),
    terminalsRef: { current: [] },
    setSessionTabs: vi.fn(),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    activeSessionTabId: 'existing-tab',
    activeSessionTabIdRef: { current: 'existing-tab' },
    setActiveSessionTabId: vi.fn(),
    setCreating: vi.fn(),
    creatingTerminalRef: { current: false },
    creatingBrowser: false,
    creatingMarkdown: false,
    setCreateError: vi.fn(),
    deviceTokenRef: { current: null },
    initializedHandlesRef: { current: new Set<string>() },
    activeHandleRef: { current: 'existing-terminal' },
    activeSessionTabTypeRef: { current: 'terminal' },
    pendingActiveSessionTabIdRef: { current: null },
    pendingActiveTerminalHandleRef: { current: null },
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    fetchSessionTabs: vi.fn(async () => {})
  }
}

describe('mobile + Codex tab creation routing', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  it('uses the structured agent-session path for a bare Codex launch', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: true,
          value: { sessionId: 'codex_session_1' }
        }
      }
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'agentSession.createSupport', {
      worktree: 'id:workspace-1',
      agent: 'codex'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'agentSession.create',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' }),
      expect.anything()
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.anything()
    )
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('agent-session:codex_session_1')
    expect(scope.setActiveHandle).toHaveBeenCalledWith(null)
    expect(scope.unsubscribeTerminal).toHaveBeenCalledWith('existing-terminal')
  })

  it('keeps the legacy terminal path when structured support is disabled', async () => {
    const client = clientReturning(
      { ok: false, error: { code: 'structured_agent_session_unsupported', message: 'off' } },
      terminalCreateResponse()
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'session.tabs.createTerminal',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('terminal-tab-1')
  })

  it('falls back to a terminal when structured creation is definitively refused', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'structured_agent_session_unsupported',
            message: 'provider unavailable'
          }
        }
      },
      terminalCreateResponse()
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(
      3,
      'session.tabs.createTerminal',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('terminal-tab-1')
  })

  it('keeps prompted Codex launches on the legacy terminal path', async () => {
    const client = clientReturning(terminalCreateResponse(), {
      ok: true,
      result: { send: { accepted: true } }
    })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex', { initialPrompt: 'Inspect this diff' })
    })

    expect(client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({ agent: 'codex' })
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'agentSession.createSupport',
      expect.anything()
    )
  })

  it('does not create a legacy sibling after an unknown structured outcome', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    const sendRequest = client.sendRequest as unknown as ReturnType<typeof vi.fn>
    sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('still unknown')))
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.create'
    ])
    expect(scope.setCreateError).toHaveBeenCalledWith('still unknown')
    expect(scope.showToast).toHaveBeenCalledWith('still unknown', 1800)
  })

  it.each(['agent_session_operation_unknown', 'runtime_error', 'future_unknown_code'])(
    'does not create a legacy sibling after a top-level %s response',
    async (code) => {
      const client = clientReturning(
        { ok: true, result: { supported: true } },
        { ok: false, error: { code, message: 'create outcome ambiguous' } }
      )
      const scope = createScope(client)
      let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
      function Harness() {
        actions = useMobileSessionTerminalCreateActions(scope as never)
        return null
      }
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      await act(async () => {
        await actions?.handleCreateTerminal('codex')
      })

      const sendRequest = client.sendRequest as unknown as ReturnType<typeof vi.fn>
      expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
        'agentSession.createSupport',
        'agentSession.create'
      ])
      expect(scope.setCreateError).toHaveBeenCalledWith('create outcome ambiguous')
      expect(scope.showToast).toHaveBeenCalledWith('create outcome ambiguous', 1800)
    }
  )
  // Why: pty exhaustion, a disabled agent and an unresolved worktree owner all arrived as the
  // same 'Failed to create terminal', leaving the empty session with nothing to act on.
  it('surfaces the host reason instead of a generic terminal-create error', async () => {
    const client = clientReturning({
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'Your system cannot allocate any more pty devices.'
      }
    })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })

    expect(scope.setCreateError).toHaveBeenCalledWith(
      'Your system cannot allocate any more pty devices.'
    )
  })

  it('falls back to the generic message when the host gives no reason', async () => {
    const client = clientReturning({ ok: false, error: { code: 'runtime_error', message: '' } })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })

    expect(scope.setCreateError).toHaveBeenCalledWith('Failed to create terminal')
  })
})

describe('optimistic placement of a created tab', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  async function createLegacyTerminal(scope: ReturnType<typeof createScope>) {
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })
  }

  function tabIdsAfterCreate(
    scope: ReturnType<typeof createScope>,
    prior: { id: string }[]
  ): string[] {
    const updater = (scope.setSessionTabs as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as (
      prev: { id: string }[]
    ) => { id: string }[]
    return updater(prior).map((tab) => tab.id)
  }

  it('paints the created tab after the anchor it asked the host for, not at the end', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    await createLegacyTerminal(scope)

    expect(scope.setSessionTabs).toHaveBeenCalled()
    // The request anchored on the active tab, so the paint must land in the same slot the host
    // splices into; appending here is what made the tab jump on the next snapshot.
    expect(tabIdsAfterCreate(scope, [{ id: 'existing-tab' }, { id: 'trailing-tab' }])).toEqual([
      'existing-tab',
      'terminal-tab-1',
      'trailing-tab'
    ])
  })

  it('paints after the active split parent, matching headed host placement', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    scope.activeSessionTabId = 'existing-tab::left'
    await createLegacyTerminal(scope)

    expect(
      tabIdsAfterCreate(scope, [
        { id: 'existing-tab::left', parentTabId: 'existing-tab' },
        { id: 'existing-tab::right', parentTabId: 'existing-tab' },
        { id: 'trailing-tab' }
      ])
    ).toEqual(['existing-tab::left', 'existing-tab::right', 'terminal-tab-1', 'trailing-tab'])
  })

  it('keeps legacy leaf placement for an older host', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.activeSessionTabId = 'existing-tab::left'
    await createLegacyTerminal(scope)

    expect(
      tabIdsAfterCreate(scope, [
        { id: 'existing-tab::left', parentTabId: 'existing-tab' },
        { id: 'existing-tab::right', parentTabId: 'existing-tab' },
        { id: 'trailing-tab' }
      ])
    ).toEqual(['existing-tab::left', 'terminal-tab-1', 'existing-tab::right', 'trailing-tab'])
  })

  it('sends the same anchor it paints with', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    await createLegacyTerminal(scope)

    expect(scope.client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({ afterTabId: 'existing-tab' })
    )
  })

  it('appends when the anchor is not in the client list, matching the host fallback', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    await createLegacyTerminal(scope)

    expect(tabIdsAfterCreate(scope, [{ id: 'unrelated-tab' }])).toEqual([
      'unrelated-tab',
      'terminal-tab-1'
    ])
  })

  it('leaves the list alone when the host snapshot already placed the tab', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    await createLegacyTerminal(scope)

    const prior = [{ id: 'existing-tab' }, { id: 'terminal-tab-1' }, { id: 'trailing-tab' }]
    expect(tabIdsAfterCreate(scope, prior)).toEqual([
      'existing-tab',
      'terminal-tab-1',
      'trailing-tab'
    ])
  })
})
