import { providerStartupFailureFact } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { openCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { codexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'
import { openCodexThread } from './codex-structured-thread-open'

function connectionFor(
  request: CodexAppServerConnection['request']
): Pick<CodexAppServerConnection, 'request'> {
  return { request }
}

describe('openCodexThread', () => {
  it('gives developer instructions to a new thread only', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => ({
      thread: { id: method === 'thread/start' ? 'thread-created' : 'thread-existing' }
    }))
    const developerInstructions = 'You are Reviewer.'

    for (const resumeThreadId of [null, 'thread-existing']) {
      await openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId, developerInstructions },
        2_000
      )
    }

    expect(
      request.mock.calls.map(([method, params]) => [method, params?.developerInstructions])
    ).toEqual([
      ['thread/start', developerInstructions],
      ['thread/resume', undefined]
    ])
  })

  // Omitting policy can inherit approval_policy = never and suppress Ask prompts.
  it('sends Ask as an explicit policy on resume, not as absent fields', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      thread: { id: 'thread-existing' }
    }))
    const permissionPolicy = codexStructuredPermissionPolicy('ask')

    await openCodexThread(
      connectionFor(request),
      { cwd: '/workspace', resumeThreadId: 'thread-existing', permissionPolicy },
      2_000
    )

    const params = request.mock.calls[0]?.[1] ?? {}
    expect(params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      approvalsReviewer: 'user'
    })
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(['approvalPolicy', 'sandbox', 'approvalsReviewer'])
    )
    expect(params).not.toHaveProperty('sandboxPolicy')
  })

  it('does not retry without excludeTurns after an unsupported-field refusal', async () => {
    const refusal = new CodexAppServerRequestError(
      'thread/resume',
      -32602,
      'unknown field excludeTurns'
    )
    const request = vi.fn(async () => {
      throw refusal
    })
    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-1' },
        2_000
      )
    ).rejects.toBe(refusal)
    expect(request).toHaveBeenCalledOnce()
  })

  it('unarchives a thread archived in Codex and reopens that same thread', async () => {
    let archived = true
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/unarchive') {
        archived = false
        return {}
      }
      if (method === 'thread/resume' && archived) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32600,
          `session ${String(params?.threadId)} is archived. Run \`codex unarchive ${String(params?.threadId)}\` to unarchive it first.`
        )
      }
      return { thread: { id: params?.threadId ?? 'thread-new' } }
    })

    await expect(
      openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-archived', supersedeIfUnsaved: true },
        2_000
      )
    ).resolves.toMatchObject({ threadId: 'thread-archived' })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/resume',
      'thread/unarchive',
      'thread/resume'
    ])
    expect(request.mock.calls[1]?.[1]).toEqual({ threadId: 'thread-archived' })
  })

  it('never replaces an archived thread whose saved conversation is gone after unarchiving', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/resume' && request.mock.calls.length === 1) {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32600,
          'session thread-a is archived.'
        )
      }
      if (method === 'thread/resume') {
        throw new CodexAppServerRequestError(
          'thread/resume',
          -32600,
          'no rollout found for thread id thread-a'
        )
      }
      return method === 'thread/unarchive' ? {} : { thread: { id: 'thread-new' } }
    })
    const error = await openCodexThread(
      connectionFor(request),
      { cwd: '/workspace', resumeThreadId: 'thread-a', supersedeIfUnsaved: true },
      2_000
    ).catch((error: unknown) => error)

    expect(providerStartupFailureFact(error)).toMatchObject({ kind: 'savedConversationMissing' })
    expect(request.mock.calls.map(([method]) => method)).not.toContain('thread/start')
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

    it('explains a missing saved conversation without replacing it', async () => {
      const request = codexWithoutRollout()
      const error = await openCodexThread(
        connectionFor(request),
        { cwd: '/workspace', resumeThreadId: 'thread-unsaved' },
        2_000
      ).catch((error: unknown) => error)

      expect(providerStartupFailureFact(error)).toMatchObject({
        kind: 'savedConversationMissing',
        detail: {
          text: expect.stringContaining('no rollout found for thread id thread-unsaved'),
          audience: 'log'
        }
      })
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

it('keeps an exact active-writer refusal typed through cleanup wrapping', async () => {
  const error = new CodexAppServerRequestError(
    'thread/resume',
    -32600,
    'thread C already has an active writer'
  )
  const request = vi.fn().mockRejectedValue(error)
  let refused: unknown
  try {
    await openCodexThread(connectionFor(request), { cwd: '/workspace', resumeThreadId: 'C' }, 2_000)
  } catch (caught) {
    refused = caught
  }
  expect(refused).toMatchObject({ reason: 'conversationOpenElsewhere' })
  expect(providerStartupFailureFact(new AggregateError([refused], 'cleanup failed'))).toMatchObject(
    {
      kind: 'conversationOpenElsewhere',
      detail: { text: error.message, audience: 'log' }
    }
  )
  expect(request).toHaveBeenCalledOnce()
})
