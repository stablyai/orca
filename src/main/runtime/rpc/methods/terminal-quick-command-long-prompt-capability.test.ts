import { describe, expect, it, vi } from 'vitest'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../../../../shared/terminal-quick-command-prompt-limit'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY } from '../../../../shared/terminal-quick-command-capabilities'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('quick-command prompts longer than older clients accept', () => {
  const shortCommand: TerminalQuickCommand = {
    id: 'status',
    label: 'Status',
    action: 'terminal-command',
    command: 'git status',
    appendEnter: true,
    scope: { type: 'global' }
  }
  const longCommand: TerminalQuickCommand = {
    id: 'review',
    label: 'Review',
    action: 'agent-prompt',
    agent: 'claude',
    prompt: 'x'.repeat(LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH + 1),
    scope: { type: 'global' }
  }

  function makeDispatcher(): {
    dispatcher: RpcDispatcher
    update: ReturnType<typeof vi.fn>
  } {
    const update = vi.fn(() => [shortCommand, longCommand])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers call only the quick-command methods stubbed here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientTerminalQuickCommands: vi.fn(() => [shortCommand, longCommand]),
      updateClientTerminalQuickCommands: update
    } as unknown as OrcaRuntimeService
    return { dispatcher: new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS }), update }
  }

  it('stores a long prompt instead of refusing it', async () => {
    const { dispatcher, update } = makeDispatcher()
    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: longCommand }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledWith({ type: 'upsert', command: longCommand })
  })

  it('withholds long prompts from a client that cannot read them', async () => {
    const { dispatcher } = makeDispatcher()
    const olderClient = { clientKind: 'mobile' as const, clientCapabilities: [] }

    for (const request of [
      makeRequest('settings.getTerminalQuickCommands'),
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'delete', id: 'other' }
      })
    ]) {
      const response = await dispatcher.dispatch(request, olderClient)
      expect(response).toMatchObject({
        ok: true,
        result: { terminalQuickCommands: [shortCommand] }
      })
    }
  })

  it('publishes long prompts to clients that advertise support and to in-process callers', async () => {
    const { dispatcher } = makeDispatcher()
    for (const options of [
      {
        clientKind: 'mobile' as const,
        clientCapabilities: [TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY]
      },
      undefined
    ]) {
      const response = await dispatcher.dispatch(
        makeRequest('settings.getTerminalQuickCommands'),
        options
      )
      expect(response).toMatchObject({
        ok: true,
        result: { terminalQuickCommands: [shortCommand, longCommand] }
      })
    }
  })
})
