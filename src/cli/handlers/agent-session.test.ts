import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { AGENT_SESSION_HANDLERS } from './agent-session'

const call = vi.fn()

beforeEach(() => {
  call.mockReset()
  vi.mocked(printResult).mockReset()
})

describe('agent session CLI handlers', () => {
  it('resolves a worktree selector before filtering session history', async () => {
    call
      .mockResolvedValueOnce({
        result: {
          sessions: [
            {
              id: 'codex:session-1',
              agent: 'codex',
              title: 'Keep this conversation',
              project: {
                id: 'orca',
                displayName: 'Orca',
                originalWorktreeId: 'repo::/workspace/task',
                originalWorktreePath: '/workspace/task'
              }
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        result: { worktree: { id: 'repo::/workspace/task', path: '/workspace/task' } }
      })

    await AGENT_SESSION_HANDLERS['agent session list']({
      flags: new Map([['worktree', 'path:/workspace/task']]),
      client: { call },
      cwd: '/workspace/task',
      json: false
    } as never)

    expect(call).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: 'path:/workspace/task'
    })
    const output = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { sessions: { id: string }[] }
    }
    expect(output.result.sessions).toEqual([expect.objectContaining({ id: 'codex:session-1' })])
  })

  it('reports a successful terminal close as stopped', async () => {
    call.mockResolvedValue({
      result: { handle: 'term_1', tabId: 'tab-1', ptyKilled: true }
    })

    await AGENT_SESSION_HANDLERS['agent session stop']({
      flags: new Map([['session', 'codex:session-1']]),
      client: { call },
      cwd: '/workspace/task',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((value: { handle: string; tabId: string; ptyKilled: boolean }) => string)
      | undefined
    expect(formatter?.({ handle: 'term_1', tabId: 'tab-1', ptyKilled: false })).toBe(
      'term_1\tstopped'
    )
  })
})
