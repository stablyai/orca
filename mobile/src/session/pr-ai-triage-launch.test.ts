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

function clientReturning(...responses: RpcResponse[]) {
  const sendRequest = vi.fn(async () => responses[sendRequest.mock.calls.length - 1])
  return { sendRequest }
}

describe('createTerminalAndSendPrompt', () => {
  it('creates a terminal then sends the prompt with enter', async () => {
    const client = clientReturning(createdTerminal, sendAccepted)
    await createTerminalAndSendPrompt(client, 'wt-1', 'do the thing')

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'session.tabs.createTerminal', {
      worktree: 'id:wt-1'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'term-1',
      text: 'do the thing',
      enter: true
    })
  })

  it('throws and skips terminal.send when createTerminal fails', async () => {
    const client = clientReturning(failure('boom'))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow('boom')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('throws when the created-terminal response is malformed', async () => {
    const client = clientReturning(success({ tab: { type: 'terminal' } }))
    await expect(createTerminalAndSendPrompt(client, 'wt-1', 'p')).rejects.toThrow(
      'Created terminal response was invalid'
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
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
