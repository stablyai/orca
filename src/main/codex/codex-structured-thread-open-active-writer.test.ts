// A resume that meets Codex's lock on a thread another process still writes: right after Orca
// killed the previous app-server, the OS has not yet dropped that process's lock.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRequestError,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import {
  CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS,
  openCodexThread
} from './codex-structured-thread-open'

const THREAD = 'thread-1'

function activeWriter(threadId = THREAD, code = -32600): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    'thread/resume',
    code,
    `codex app-server thread/resume failed: thread ${threadId} already has an active writer`
  )
}

/** Codex refusing the resume `refusals` times, then opening the thread. */
function codexHeldFor(refusals: number, error: Error = activeWriter()) {
  let left = refusals
  return vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === 'thread/resume' && left > 0) {
      left -= 1
      throw error
    }
    return { thread: { id: THREAD } }
  })
}

function resume(request: ReturnType<typeof codexHeldFor>) {
  return openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: THREAD }, 2_000)
}

afterEach(() => vi.useRealTimers())

describe('openCodexThread after the previous writer', () => {
  it('resumes once the previous process lets go of the thread, waiting 100 then 400 ms', async () => {
    vi.useFakeTimers()
    const request = codexHeldFor(2)

    const opened = resume(request)
    await vi.advanceTimersByTimeAsync(99)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(400)

    await expect(opened).resolves.toMatchObject({ threadId: THREAD })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('fails that one resume with the refusal once every retry met the lock', async () => {
    vi.useFakeTimers()
    const request = codexHeldFor(Number.POSITIVE_INFINITY)

    const opened = resume(request)
    const settled = expect(opened).rejects.toThrow('already has an active writer')
    await vi.advanceTimersByTimeAsync(
      CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
    )

    await settled
    expect(request).toHaveBeenCalledTimes(CODEX_ACTIVE_WRITER_RETRY_DELAYS_MS.length + 1)
  })

  it.each([
    ['another thread', activeWriter('thread-other')],
    ['another code', activeWriter(THREAD, -32603)],
    ['any other refusal', new CodexAppServerRequestError('thread/resume', -32600, 'bad cwd')]
  ])('does not wait on %s', async (_case, error) => {
    const request = codexHeldFor(1, error)

    await expect(resume(request)).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(1)
  })

  // Every other test builds the error itself; this one sends Codex's raw JSON-RPC frame through
  // the real connection, so a change to Orca's own error wording cannot hide the refusal.
  it("recognizes Codex's raw refusal frame through the real connection", async () => {
    const fakeAppServer = String.raw`
      const readline = require('node:readline')
      const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
      let refusals = 1
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method === 'initialize') return send({ id: message.id, result: {} })
        if (message.method === 'thread/resume' && refusals-- > 0) {
          const threadId = message.params.threadId
          return send({
            id: message.id,
            error: { code: -32600, message: 'thread ' + threadId + ' already has an active writer' }
          })
        }
        if (message.method === 'thread/resume') {
          return send({ id: message.id, result: { thread: { id: message.params.threadId } } })
        }
      })
    `
    const connection = await openCodexAppServerConnection({
      command: process.execPath,
      args: ['-e', fakeAppServer]
    })
    try {
      await expect(
        openCodexThread(connection, { cwd: '/workspace', resumeThreadId: THREAD }, 5_000)
      ).resolves.toMatchObject({ threadId: THREAD })
    } finally {
      await connection.close()
    }
  })
})
