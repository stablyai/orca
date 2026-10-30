import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  openProviderTimelineRig,
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
afterEach(closeProviderTimelineRigs)
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import { openCodexAppServerConnection } from './codex-app-server-connection'

function stubChild() {
  const child = Object.assign(new EventEmitter(), {
    // Outside any real process table so teardown never mistakes an unrelated process for it.
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return { child, spawnImpl }
}

describe('Codex app-server exit order', () => {
  it('reports an exit whose stdout ended first once the exit is seen, with its usual reason', async () => {
    const { child, spawnImpl } = stubChild()
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onExit: (error) => {
          exits.push(error.message)
        }
      },
      spawnImpl
    )

    child.stderr.write('codex crashed\n')
    child.stdout.end()
    // Stream writes land a tick later, so the stderr tail is only complete here.
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])
    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect(exits).toHaveLength(1)
    expect(exits[0]).toContain('codex crashed')
    await connection.close()
  })
})

it.each(['root-exit', 'requested-close'] as const)(
  'transfers a separate received stdout chunk before %s retires the translator',
  async (ending) => {
    const rig = await openProviderTimelineRig()
    const translator = createCodexJournalTranslator({
      sink: rig.eventSink,
      sessionId: SESSION,
      primaryThreadId: () => 'thread'
    })
    const { child, spawnImpl } = stubChild()
    const writer = Promise.withResolvers<void>()
    const delivered: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onNotification: (method, params) => {
          delivered.push(method)
          translator.handle({
            type: 'notification',
            sessionId: SESSION,
            threadId: 'thread',
            method,
            params
          })
        },
        onExit: (_error, exit) => {
          delivered.push('exit')
          return exit?.inputDone?.then(() => {
            translator.dispose()
            delivered.push('complete')
          })
        }
      },
      spawnImpl
    )
    const unbind = rig.eventSink.bindReadingControl?.({
      pauseReading: () => connection.pauseReading?.(),
      resumeReading: () => connection.resumeReading?.()
    })
    try {
      child.stdout.write(
        `${JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: {
              id: 'tool',
              type: 'commandExecution',
              command: 'echo result',
              status: 'inProgress'
            }
          }
        })}\n`
      )
      void rig.journal.readInOrder(() => writer.promise)
      for (let index = 0; index < 512; index++) {
        rig.eventSink.appendItem(
          { provider: 'orca', clientMessageId: `pressure-${index}` },
          { kind: 'status', tone: 'info', text: 'queued' },
          { turnScope: { kind: 'thread' } }
        )
      }
      const final = {
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: {
            id: 'tool',
            type: 'commandExecution',
            command: 'echo result',
            status: 'completed',
            aggregatedOutput: 'complete paused result',
            exitCode: 0
          }
        }
      }
      child.stdout.write(`${JSON.stringify(final)}\n`)
      expect(child.stdout.readableLength).toBeGreaterThan(0)
      expect(delivered).toEqual(['item/started'])
      const closing = ending === 'requested-close' ? connection.close() : undefined
      child.emit('exit', 0, null)
      expect(connection.closed).toBe(true)
      await expect(connection.request('turn/start')).rejects.toThrow()
      child.stdout.end()
      await (closing ?? connection.close())
      expect(delivered).toEqual(['item/started', 'exit', 'item/completed', 'complete'])
      writer.resolve()
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
      expect(tools).toHaveLength(1)
      expect(tools[0].body).toMatchObject({
        state: 'completed',
        output: { head: 'complete paused result', truncated: false, byteLength: 22 }
      })
    } finally {
      writer.resolve()
      child.stdout.end()
      await connection.close()
      unbind?.()
      translator.dispose()
    }
  }
)

it.each(['thread/start', 'turn/start'] as const)(
  'normalizes an already sent %s response before terminal source retirement',
  async (method) => {
    const { z } = await import('zod')
    const { adapterFor, fakeCodex, identityFor, USER_MESSAGE, THREAD_ID } =
      await import('./codex-structured-session-adapter-fixture')
    const { spawnCodexAppServerConnection } = await import('./codex-app-server-connection')
    const rig = await openProviderTimelineRig()
    const { child, spawnImpl } = stubChild()
    child.stdin.removeAllListeners('data')
    const request = Promise.withResolvers<{ id: number; method: string }>()
    const frame = z.object({ id: z.number().optional(), method: z.string() })
    child.stdin.on('data', (chunk: Buffer) => {
      const sent = frame.parse(JSON.parse(chunk.toString()))
      if (sent.id === undefined) {
        return
      }
      if (sent.method === method) {
        request.resolve({ id: sent.id, method: sent.method })
        return
      }
      const result =
        sent.method === 'thread/start' ? { thread: { id: THREAD_ID }, serviceTier: 'standard' } : {}
      child.stdout.write(`${JSON.stringify({ id: sent.id, result })}\n`)
    })
    const settlements: unknown[] = []
    const adapter = adapterFor(fakeCodex(), {}, [], {
      openConnection: (launch, handlers) =>
        spawnCodexAppServerConnection(launch, handlers, spawnImpl),
      onDispatchSettledLate: (event) => settlements.push(event)
    })
    try {
      const acquired = await adapter.acquire({
        identity: identityFor(SESSION),
        fence: 7,
        spawnToken: 'received-response',
        events: rig.eventSink
      })
      const opening = adapter.open({
        sessionId: SESSION,
        fence: 7,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      if (method === 'turn/start') {
        await opening
      }
      const dispatch =
        method === 'turn/start'
          ? adapter.dispatch({
              sessionId: SESSION,
              fence: 7,
              clientMessageId: 'received-send',
              body: USER_MESSAGE
            })
          : undefined
      const answered = await request.promise
      const opened =
        method === 'thread/start'
          ? {
              thread: {
                id: THREAD_ID,
                turns: [
                  {
                    id: 'received-turn',
                    status: 'completed',
                    items: [
                      {
                        id: 'received-tool',
                        type: 'commandExecution',
                        command: 'echo whole',
                        status: 'completed',
                        aggregatedOutput: 'whole response-owned output',
                        exitCode: 0
                      }
                    ]
                  }
                ]
              },
              serviceTier: 'standard'
            }
          : { turn: { id: 'received-turn' } }
      const openingOutcome = opening.catch((error: unknown) => error)
      child.stdout.pause()
      if (method === 'turn/start') {
        child.stdout.write(
          `${JSON.stringify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'received-turn' } } })}\n`
        )
      }
      child.stdout.write(`${JSON.stringify({ id: answered.id, result: opened })}\n`)
      if (method === 'turn/start') {
        child.stdout.write(
          `${JSON.stringify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'received-turn', status: 'failed', error: { message: 'provider refused this turn' } } } })}\n`
        )
      }
      child.emit('exit', 0, null)
      child.stdout.end()
      await expect(adapter.closeSession(SESSION)).rejects.toThrow(
        'process tree was not proven gone'
      )
      if (dispatch) {
        await dispatch
        expect(settlements).toContainEqual(
          expect.objectContaining({
            clientMessageId: 'received-send',
            state: 'rejected',
            answeredInTurn: expect.anything()
          })
        )
      } else {
        expect(await openingOutcome).toBeInstanceOf(Error)
        const reopened = await rig.reopenJournal()
        expect(reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')).toEqual([
          expect.objectContaining({
            itemId: expect.stringContaining('received-tool'),
            body: expect.objectContaining({
              state: 'completed',
              output: expect.objectContaining({
                head: 'whole response-owned output',
                truncated: false
              })
            })
          })
        ])
      }
    } finally {
      child.emit('exit', 0, null)
      child.stdout.end()
      await adapter.closeAll()
    }
  }
)
