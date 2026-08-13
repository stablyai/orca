import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { createTerminalAndSendPrompt } from './pr-ai-triage-launch'

function success(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function failure(message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code: 'E', message }, _meta: { runtimeId: 'r' } }
}

const createdTerminal = success({ tab: { type: 'terminal', id: 't1', terminal: 'term-1' } })
const sendAccepted = success({ send: { accepted: true } })
const safeHost = success({
  runtimeId: 'r',
  capabilities: ['terminal.attribution-removed.v1']
})

function clientReturning(...responses: RpcResponse[]) {
  const sendRequest = vi.fn(async () => responses[sendRequest.mock.calls.length - 1])
  return { sendRequest }
}

describe('createTerminalAndSendPrompt', () => {
  it('creates a terminal then sends the prompt with enter', async () => {
    const client = clientReturning(safeHost, createdTerminal, sendAccepted)
    await createTerminalAndSendPrompt(client, 'wt-1', 'do the thing')

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'status.get', undefined, {
      timeoutMs: 30_000,
      budgetSpansConnect: true
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'session.tabs.createTerminal',
      {
        worktree: 'id:wt-1',
        env: { ORCA_ATTRIBUTION_BYPASS: '1' },
        envToDelete: ['ORCA_ENABLE_GIT_ATTRIBUTION'],
        activate: false,
        select: true,
        navigation: 'caller'
      },
      { timeoutMs: 30_000, budgetSpansConnect: true, expectedRuntimeId: 'r' }
    )
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'terminal.send', {
      terminal: 'term-1',
      text: 'do the thing',
      enter: true
    })
  })

  it('throws and skips terminal.send when createTerminal fails', async () => {
    const client = clientReturning(safeHost, failure('boom'))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow('boom')
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('throws when the created-terminal response is malformed', async () => {
    const client = clientReturning(safeHost, success({ tab: { type: 'terminal' } }))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Created terminal response was invalid'
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('throws when terminal.send returns a failure', async () => {
    const client = clientReturning(safeHost, createdTerminal, failure('send failed'))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow('send failed')
  })

  it('throws when terminal input is locked', async () => {
    const client = clientReturning(
      safeHost,
      createdTerminal,
      success({ send: { accepted: false } })
    )
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Terminal input is locked'
    )
  })

  it('refuses an old host before terminal creation', async () => {
    const client = clientReturning(success({ appVersion: '1.4.89' }))

    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Update the host and try again'
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })
})
