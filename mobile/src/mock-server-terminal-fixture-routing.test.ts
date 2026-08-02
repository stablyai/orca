import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import {
  handleRequest,
  type RpcRequest,
  type RpcResponse
} from '../scripts/mock-server-rpc-handlers'

let requestSequence = 0

function sendMockRequest(method: string, params?: Record<string, unknown>): RpcResponse {
  let response: RpcResponse | undefined
  const request: RpcRequest = { id: `request-${++requestSequence}`, method, params }
  handleRequest(
    request,
    (nextResponse) => {
      response = nextResponse
    },
    {} as WebSocket
  )
  expect(response).toBeDefined()
  return response!
}

function listedTerminalWorktreeIds(worktree?: string): string[] {
  const response = sendMockRequest('terminal.list', worktree ? { worktree } : undefined)
  const result = response.result as { terminals: Array<{ worktreeId: string }> }
  return [...new Set(result.terminals.map((terminal) => terminal.worktreeId))]
}

describe('mock server terminal fixture routing', () => {
  it('follows worktree creation and activation', () => {
    const worktreeResponse = sendMockRequest('worktree.ps')
    const initialWorktreeId = (
      worktreeResponse.result as { worktrees: Array<{ worktreeId: string }> }
    ).worktrees[0]!.worktreeId

    const createResponse = sendMockRequest('worktree.create', {
      repo: 'id:repo-1',
      name: 'terminal-fixture-routing'
    })
    const createdWorktreeId = (createResponse.result as { worktree: { id: string } }).worktree.id
    expect(listedTerminalWorktreeIds()).toEqual([createdWorktreeId])
    expect(listedTerminalWorktreeIds(`id:${initialWorktreeId}`)).toEqual([initialWorktreeId])

    sendMockRequest('worktree.activate', { worktree: `id:${initialWorktreeId}` })
    expect(listedTerminalWorktreeIds()).toEqual([initialWorktreeId])
  })
})
