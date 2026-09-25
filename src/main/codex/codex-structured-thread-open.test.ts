import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerFrameSizeError,
  CodexAppServerRequestError,
  openCodexAppServerConnection,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { codexStructuredPermissionPolicyForSettings } from './codex-structured-permission-policy'
import { openCodexThread } from './codex-structured-thread-open'

function connectionFor(
  request: CodexAppServerConnection['request']
): Pick<CodexAppServerConnection, 'request'> {
  return { request }
}

describe('openCodexThread', () => {
  it('applies the resolved permission policy when starting and resuming a thread', async () => {
    const request = vi.fn(async (method: string) => ({
      thread: { id: method === 'thread/start' ? 'thread-created' : 'thread-existing' }
    }))
    const connection = connectionFor(request)
    const permissionPolicy = {
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const
    }

    await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: null, permissionPolicy },
      2_000
    )
    await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'thread-existing', permissionPolicy },
      2_000
    )

    expect(request).toHaveBeenNthCalledWith(
      1,
      'thread/start',
      { cwd: '/workspace', approvalPolicy: 'never', sandbox: 'danger-full-access' },
      { timeoutMs: 2_000 }
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'thread/resume',
      {
        threadId: 'thread-existing',
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        excludeTurns: true
      },
      { timeoutMs: 2_000 }
    )
  })

  // The regression this pins: Manual used to resolve to no policy at all, and the params below
  // spread it — so neither field was sent and app-server fell back to the config.toml of the
  // home Orca mirrors from the user's ~/.codex. With `approval_policy = "never"` there, a Manual
  // session never prompted; a resume separately inherits the policy it was last started with.
  it('sends Manual as an explicit policy on resume, not as absent fields', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      thread: { id: 'thread-existing' }
    }))
    const permissionPolicy = codexStructuredPermissionPolicyForSettings({
      agentDefaultArgs: { codex: '' }
    })

    await openCodexThread(
      connectionFor(request),
      { cwd: '/workspace', resumeThreadId: 'thread-existing', permissionPolicy },
      2_000
    )

    const params = request.mock.calls[0]?.[1] ?? {}
    expect(params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    // Absence is the bug, so assert the keys are carried, not merely that they are not Yolo.
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['approvalPolicy', 'sandbox']))
  })

  it('preserves an explicitly reported service tier, including Standard', async () => {
    const priority = vi.fn(async () => ({
      thread: { id: 'thread-fast' },
      serviceTier: 'priority-live'
    }))
    await expect(
      openCodexThread(connectionFor(priority), { cwd: '/workspace', resumeThreadId: null }, 2_000)
    ).resolves.toMatchObject({ threadId: 'thread-fast', serviceTier: 'priority-live' })

    const standard = vi.fn(async () => ({ thread: { id: 'thread-standard' }, serviceTier: null }))
    await expect(
      openCodexThread(connectionFor(standard), { cwd: '/workspace', resumeThreadId: null }, 2_000)
    ).resolves.toEqual({
      threadId: 'thread-standard',
      thread: { id: 'thread-standard' },
      historyPath: null,
      serviceTier: null
    })
  })

  it('requests metadata-only state when resuming an existing thread', async () => {
    const request = vi.fn(async () => ({
      thread: { id: 'thread-1', path: '/history/thread-1.jsonl' },
      model: 'gpt-live'
    }))

    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-1', resumePath: '/history/thread-1.jsonl' },
        2_000
      )
    ).resolves.toMatchObject({ threadId: 'thread-1', model: 'gpt-live' })

    expect(request).toHaveBeenCalledWith(
      'thread/resume',
      {
        threadId: 'thread-1',
        cwd: '/workspace',
        path: '/history/thread-1.jsonl',
        excludeTurns: true
      },
      { timeoutMs: 2_000 }
    )
  })

  it('caches a narrowly proven excludeTurns refusal and uses one bounded fallback', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32602,
          'codex app-server thread/resume failed: unknown field `excludeTurns`'
        )
      }
      return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', items: [] }] } }
    })
    const connection = connectionFor(request)

    const first = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'thread-1' },
      2_000
    )
    const second = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'thread-1' },
      2_000
    )

    expect(first.thread?.turns).toHaveLength(1)
    expect(second.thread?.turns).toHaveLength(1)
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ excludeTurns: true }),
      { threadId: 'thread-1', cwd: '/workspace' },
      { threadId: 'thread-1', cwd: '/workspace' }
    ])
  })

  it('does not retry ambiguous invalid params or oversized history responses', async () => {
    const invalid = new CodexAppServerRequestError(
      'thread/resume',
      -32602,
      'codex app-server thread/resume failed: invalid params'
    )
    const invalidRequest = vi.fn(async () => {
      throw invalid
    })
    await expect(
      openCodexThread(
        connectionFor(invalidRequest),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBe(invalid)
    expect(invalidRequest).toHaveBeenCalledOnce()

    const oversized = new CodexAppServerFrameSizeError('thread/resume', 16_777_217, 16_777_216)
    const oversizedRequest = vi.fn(async () => {
      throw oversized
    })
    await expect(
      openCodexThread(
        connectionFor(oversizedRequest),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBe(oversized)
    expect(oversizedRequest).toHaveBeenCalledOnce()
  })

  it('accepts a fallback result beyond the daemon wire limit', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.excludeTurns) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32602,
          'codex app-server thread/resume failed: unsupported excludeTurns parameter'
        )
      }
      return {
        thread: {
          id: 'thread-1',
          turns: [{ id: 'turn-1', items: [{ output: 'x'.repeat(16 * 1024 * 1024 + 1) }] }]
        }
      }
    })

    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).resolves.toMatchObject({ threadId: 'thread-1' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  describe('a thread Codex never saved', () => {
    const noRollout = (threadId: string, code = -32600) =>
      new CodexAppServerRequestError(
        'thread/resume',
        code,
        `codex app-server thread/resume failed: no rollout found for thread id ${threadId}`
      )
    function codexWithoutRollout(error: Error = noRollout('thread-unsaved')) {
      return vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === 'thread/resume') {
          throw error
        }
        return { thread: { id: 'thread-new' }, model: 'gpt-live' }
      })
    }

    it('starts a new thread in its place when Codex proves it holds no rollout', async () => {
      const request = codexWithoutRollout()

      await expect(
        openCodexThread(
          connectionFor(request),
          { cwd: '/workspace', resumeThreadId: 'thread-unsaved', supersedeIfUnsaved: true },
          2_000
        )
      ).resolves.toMatchObject({
        threadId: 'thread-new',
        supersededThreadId: 'thread-unsaved',
        model: 'gpt-live'
      })
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        'thread/resume',
        'thread/start'
      ])
      expect(request).toHaveBeenLastCalledWith(
        'thread/start',
        { cwd: '/workspace' },
        {
          timeoutMs: 2_000
        }
      )
    })

    it('keeps the resume failure for a thread a resume already proved', async () => {
      const request = codexWithoutRollout()

      await expect(
        openCodexThread(
          connectionFor(request),
          { cwd: '/workspace', resumeThreadId: 'thread-unsaved' },
          2_000
        )
      ).rejects.toThrow('no rollout found for thread id thread-unsaved')
      expect(request).toHaveBeenCalledOnce()
    })

    it('treats no other resume failure as proof that nothing was saved', async () => {
      const failures = [
        noRollout('thread-other'),
        noRollout('thread-unsaved', -32603),
        new CodexAppServerRequestError(
          'thread/resume',
          -32600,
          'codex app-server thread/resume failed: thread not found'
        ),
        new Error('codex app-server exited')
      ]
      for (const failure of failures) {
        const request = codexWithoutRollout(failure)
        await expect(
          openCodexThread(
            connectionFor(request),
            { cwd: '/workspace', resumeThreadId: 'thread-unsaved', supersedeIfUnsaved: true },
            2_000
          )
        ).rejects.toBe(failure)
        expect(request).toHaveBeenCalledOnce()
      }
    })

    // Every other test here builds the error itself; this one sends Codex's raw JSON-RPC frame
    // through the real connection, so a change to Orca's own error wording cannot hide the proof.
    it('recognizes the raw frame Codex sends, through the real connection', async () => {
      const fakeAppServer = String.raw`
        const readline = require('node:readline')
        const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
        readline.createInterface({ input: process.stdin }).on('line', (line) => {
          const message = JSON.parse(line)
          if (message.method === 'initialize') return send({ id: message.id, result: {} })
          if (message.method === 'thread/resume') {
            const threadId = message.params.threadId
            return send({
              id: message.id,
              error: { code: -32600, message: 'no rollout found for thread id ' + threadId }
            })
          }
          if (message.method === 'thread/start') {
            return send({ id: message.id, result: { thread: { id: 'thread-new' } } })
          }
        })
      `
      const connection = await openCodexAppServerConnection({
        command: process.execPath,
        args: ['-e', fakeAppServer]
      })
      try {
        await expect(
          openCodexThread(
            connection,
            { cwd: '/workspace', resumeThreadId: 'thread-unsaved', supersedeIfUnsaved: true },
            5_000
          )
        ).resolves.toMatchObject({ threadId: 'thread-new', supersededThreadId: 'thread-unsaved' })
      } finally {
        await connection.close()
      }
    })
  })
})
