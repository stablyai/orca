import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { deliverWatchPromptReply } from './watch-prompt-delivery'
import type { PendingWatchPrompt } from './watch-prompt-action'

const ESCAPE = '\u001b'
const pending: PendingWatchPrompt = {
  hostId: 'host-1',
  worktreeId: 'folder:/work',
  paneKey: 'tab:leaf',
  action: 'allow',
  reply: { allow: '1', deny: ESCAPE }
}

function ok(result: unknown): RpcResponse {
  return { id: '1', ok: true, result }
}

describe('deliverWatchPromptReply', () => {
  it('types the allow key while the terminal is still waiting on a permission', async () => {
    const sent: string[] = []
    const outcome = await deliverWatchPromptReply({
      client: {
        sendRequest: async (method: string) => {
          if (method === 'terminal.resolvePane') {
            return ok({ terminal: { handle: 'pty-1' } })
          }
          return ok({
            agentStatus: { handle: 'pty-1', isRunningAgent: true, status: 'permission' }
          })
        }
      },
      pending,
      send: async (_terminal, text) => {
        sent.push(text)
        return 'accepted'
      }
    })
    expect(outcome).toBe('accepted')
    expect(sent).toEqual(['1'])
  })

  it('does not type after the permission has closed', async () => {
    const sent: string[] = []
    const outcome = await deliverWatchPromptReply({
      client: {
        sendRequest: async (method: string) => {
          if (method === 'terminal.resolvePane') {
            return ok({ terminal: { handle: 'pty-2' } })
          }
          return ok({ agentStatus: { handle: 'pty-2', isRunningAgent: true, status: 'working' } })
        }
      },
      pending,
      send: async () => {
        sent.push('sent')
        return 'accepted'
      }
    })
    expect(outcome).toBe('stale')
    expect(sent).toEqual([])
  })
})
