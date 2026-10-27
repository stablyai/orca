import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalPaneRevealTarget } from '../../../../shared/terminal-pane-reveal'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'

function request(params: unknown): RpcRequest {
  return { id: 'reveal-1', authToken: 'token', method: 'terminal.reveal', params }
}

function createDispatcher() {
  const revealTerminalPane = vi.fn(async (target: TerminalPaneRevealTarget) => ({
    ...target,
    navigated: true
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.reveal reads only these two runtime members.
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    revealTerminalPane
  } as unknown as OrcaRuntimeService
  return {
    revealTerminalPane,
    dispatcher: new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  }
}

describe('terminal.reveal', () => {
  it('reveals a paired server pane by worktree, tab and leaf', async () => {
    const { revealTerminalPane, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(
      request({
        worktreeId: 'repo-1::/srv/app',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        executionHostId: 'runtime:env-1'
      })
    )

    expect(revealTerminalPane).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/srv/app',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      executionHostId: 'runtime:env-1'
    })
    expect(response).toMatchObject({ ok: true, result: { reveal: { navigated: true } } })
  })

  it('leaves the leaf and host to the window when the caller omits them', async () => {
    const { revealTerminalPane, dispatcher } = createDispatcher()

    await dispatcher.dispatch(request({ worktreeId: 'repo-1::/srv/app', tabId: 'tab-1' }))

    expect(revealTerminalPane).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/srv/app',
      tabId: 'tab-1',
      leafId: null,
      executionHostId: null
    })
  })

  it.each(['runtime', 'mobile'] as const)(
    'refuses a paired %s client without touching the window',
    async (clientKind) => {
      const { revealTerminalPane, dispatcher } = createDispatcher()

      const response = await dispatcher.dispatch(
        request({ worktreeId: 'repo-1::/srv/app', tabId: 'tab-1' }),
        { clientKind }
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(revealTerminalPane).not.toHaveBeenCalled()
    }
  )

  it.each([
    [{ tabId: 'tab-1' }],
    [{ worktreeId: 'repo-1::/srv/app' }],
    [{ worktreeId: 'repo-1::/srv/app', tabId: 'tab-1', executionHostId: 'nowhere' }]
  ])('refuses %o without touching the window', async (params) => {
    const { revealTerminalPane, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(request(params))

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(revealTerminalPane).not.toHaveBeenCalled()
  })
})
