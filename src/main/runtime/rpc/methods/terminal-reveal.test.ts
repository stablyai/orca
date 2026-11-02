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
})
