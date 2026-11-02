import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type {
  handleRequest as handleRpcRequest,
  RpcRequest,
  RpcResponse
} from '../scripts/mock-server-rpc-handlers'

let handleRequest: typeof handleRpcRequest

beforeAll(async () => {
  vi.stubEnv('MOCK_NATIVE_CHAT', '0')
  vi.stubEnv('MOCK_REPO_COUNT', '2')
  vi.stubEnv('MOCK_WORKTREE_COUNT', '2')
  vi.stubEnv('MOCK_RPC_DELAY_MS', '0')
  for (const method of ['worktree.ps', 'worktree.create', 'worktree.activate', 'terminal.list']) {
    vi.stubEnv(`MOCK_RPC_DELAY_${method.replaceAll('.', '_').toUpperCase()}_MS`, '0')
  }
  ;({ handleRequest } = await import('../scripts/mock-server-rpc-handlers'))
})

afterAll(() => vi.unstubAllEnvs())

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
    expect(createdWorktreeId).not.toBe(initialWorktreeId)
    expect(listedTerminalWorktreeIds()).toEqual([createdWorktreeId])
    expect(listedTerminalWorktreeIds(`id:${initialWorktreeId}`)).toEqual([initialWorktreeId])

    sendMockRequest('worktree.activate', { worktree: `id:${initialWorktreeId}` })
    expect(listedTerminalWorktreeIds()).toEqual([initialWorktreeId])
  })
})
