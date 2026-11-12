import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime/client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  return { RuntimeClient }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca linear CLI handlers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    // Clear real terminal/worktree/pairing hints inherited from the test runner.
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('prints truncation on human stdout and in JSON without using stderr for JSON', async () => {
    const listResult = {
      issues: [
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix auth',
          url: 'https://linear.app/acme/issue/ENG-1',
          labels: [],
          workspace: { id: 'workspace-1', name: 'Acme' }
        }
      ],
      truncated: true,
      meta: {
        limit: 1,
        returned: 1,
        hasMore: true,
        nextCursor: 'next-page',
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1',
        partial: false,
        workspaceErrors: []
      }
    }
    queueFixtures(callMock, okFixture('req_list', listResult))
    await main(['linear', 'list-issues', '--limit', '1'], '/tmp/repo')
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain('truncated: showing 1')
    expect(
      vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes('more results'))
    ).toBe(true)

    vi.mocked(console.log).mockClear()
    vi.mocked(console.error).mockClear()
    queueFixtures(callMock, okFixture('req_list_json', listResult))
    await main(['linear', 'list-issues', '--limit', '1', '--json'], '/tmp/repo')
    const jsonOut = String(vi.mocked(console.log).mock.calls[0][0])
    expect(jsonOut).toContain('"truncated": true')
    expect(vi.mocked(console.error)).not.toHaveBeenCalled()
  })

  it('rejects --depth unless children are requested', async () => {
    await main(['linear', 'issue', 'ENG-123', '--depth', '3'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--depth requires --children or --full'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects impossible due dates before dispatch', async () => {
    await main(['linear', 'due-date', 'set', 'ENG-123', '--to', '2026-02-30'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('real calendar date')
  })

  it('requires exact write targets for issue writes', async () => {
    await main(['linear', 'comment', 'add', '--body', 'done'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Pass a Linear issue id or --current'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects --workspace all for writes before dispatch', async () => {
    await main(
      [
        'linear',
        'attach',
        'ENG-123',
        '--url',
        'https://example.com/review/123',
        '--workspace',
        'all'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--workspace all is not valid for Linear writes'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects malformed write ids before dispatch', async () => {
    await main(
      [
        'linear',
        'attach',
        'ENG-123',
        '--url',
        'https://example.com/review/123',
        '--write-id',
        'not-a-uuid',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0])) as {
      error: { code: string }
    }
    expect(payload.error.code).toBe('linear_invalid_write_id')
  })

  it('rejects duplicate body inputs before dispatch', async () => {
    await main(
      ['linear', 'create', '--title', 'Bug', '--body', 'one', '--body-file', 'body.md'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Use either --body or --body-file')
  })
})
