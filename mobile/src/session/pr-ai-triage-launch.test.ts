import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY } from './agent-launch-identity-capability'
import { MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE } from './identity-create-terminal-params'
import { createTerminalAndSendPrompt } from './pr-ai-triage-launch'

function success(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function failure(message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code: 'E', message }, _meta: { runtimeId: 'r' } }
}

const identityStatus = success({ capabilities: [MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY] })
const createdTerminal = success({ tab: { type: 'terminal', id: 't1', terminal: 'term-1' } })
const sendAccepted = success({ send: { accepted: true } })

// The capability probe always runs first; tests list only the responses after it.
function clientReturning(...responses: RpcResponse[]) {
  const all = [identityStatus, ...responses]
  const sendRequest = vi.fn(async () => all[sendRequest.mock.calls.length - 1])
  return { sendRequest }
}

describe('createTerminalAndSendPrompt', () => {
  it('creates a terminal then sends the prompt with enter', async () => {
    const client = clientReturning(createdTerminal, sendAccepted)
    await createTerminalAndSendPrompt(client, 'wt-1', 'do the thing')

    // oracle-19: the mobile launch defers to the host's newest-revision default
    // pick rather than pinning a client-cached agent id.
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'session.tabs.createTerminal', {
      worktree: 'id:wt-1',
      agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
      activate: false,
      select: true,
      navigation: 'caller'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'terminal.send', {
      terminal: 'term-1',
      text: 'do the thing',
      enter: true
    })
  })

  // Security regression: a pre-identity host strips agentLaunch and spawns a bare
  // shell, so the triage prompt would be executed as shell commands. Nothing may
  // be created, and no text may be sent.
  it('refuses the launch when the host lacks the identity capability', async () => {
    const sendRequest = vi.fn(async () => success({ capabilities: [] }))
    await expect(createTerminalAndSendPrompt({ sendRequest }, 'wt-1', 'p')).rejects.toThrow(
      MOBILE_AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it('throws and skips terminal.send when createTerminal fails', async () => {
    const client = clientReturning(failure('boom'))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow('boom')
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('throws when the created-terminal response is malformed', async () => {
    const client = clientReturning(success({ tab: { type: 'terminal' } }))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Created terminal response was invalid'
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  // Regression for L4-m11: a pre-spawn agentLaunch failure (tombstoned/disabled
  // agent, capacity, ...) is an RPC success with no `tab` key. This must surface
  // the typed failure code, not the generic "invalid response" message.
  it('throws with the typed failure code on a pre-spawn agentLaunch failure', async () => {
    const client = clientReturning(
      success({ agentLaunch: { status: 'failed', failure: { code: 'custom_agent_disabled' } } })
    )
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      "Couldn't start the agent (custom_agent_disabled)."
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('throws when terminal.send returns a failure', async () => {
    const client = clientReturning(createdTerminal, failure('send failed'))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow('send failed')
  })

  it('throws when terminal input is locked', async () => {
    const client = clientReturning(createdTerminal, success({ send: { accepted: false } }))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Terminal input is locked'
    )
  })
})
