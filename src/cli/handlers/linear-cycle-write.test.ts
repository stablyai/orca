import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', async () => {
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

  // Error formatting uses instanceof, so preserve the production error classes.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('Linear cycle CLI compatibility', () => {
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

  it.each(['save-issue', 'create'])(
    'refuses %s cycle writes to an older execution host',
    async (command) => {
      queueFixtures(callMock, okFixture('status', { capabilities: [] }))
      await main(
        ['linear', command, '--team', 'ENG', '--title', 'Task', '--cycle', 'current', '--json'],
        '/tmp/repo'
      )
      expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
      expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toMatchObject({
        ok: false,
        error: { code: 'incompatible_runtime' }
      })
    }
  )

  it.each([
    { command: 'save-issue', input: 'current', expected: 'current', method: 'linear.saveIssue' },
    { command: 'save-issue', input: 'null', expected: null, method: 'linear.saveIssue' },
    {
      command: 'create',
      input: '00000000-0000-4000-8000-000000000099',
      expected: '00000000-0000-4000-8000-000000000099',
      method: 'linear.issueCreate'
    }
  ])(
    'passes $command --cycle $input to a capable paired host',
    async ({ command, input, expected, method }) => {
      process.env.ORCA_ENVIRONMENT = 'paired-proof'
      queueFixtures(
        callMock,
        okFixture('status', { capabilities: ['linear.cycle-write.v1'] }),
        okFixture('write', { issue: { id: 'issue-proof' }, meta: { created: true } })
      )
      await main(
        ['linear', command, '--team', 'ENG', '--title', 'Task', '--cycle', input, '--json'],
        '/tmp/repo'
      )
      expect(callMock).toHaveBeenCalledWith(method, expect.objectContaining({ cycle: expected }), {
        timeoutMs: 75000
      })
    }
  )
})
