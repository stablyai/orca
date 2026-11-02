import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'

const RETRY_MS = 120_000
const WORKER_DONE = {
  from: 'term_worker',
  subject: 'done',
  type: 'worker_done',
  payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}'
}

const RuntimeRequest = z.object({
  id: z.string(),
  method: z.string(),
  orchestrationRequestId: z.string().optional()
})

const servers = new Set<Server>()
const tempDirs = new Set<string>()

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
  servers.clear()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

type CallOptions = { orchestrationRequestId?: string }

function fakeClient(respond: (attempt: number, options?: CallOptions) => unknown): {
  client: RuntimeClient
  requestIds: (string | undefined)[]
} {
  const requestIds: (string | undefined)[] = []
  const call = vi.fn(async (_method: string, _params: unknown, options?: CallOptions) => {
    requestIds.push(options?.orchestrationRequestId)
    return respond(requestIds.length, options)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callOrchestrationMutation only uses client.call.
  return { client: { call } as unknown as RuntimeClient, requestIds }
}

function unavailable(options?: CallOptions): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Could not connect to the running Orca app.',
    {
      orchestrationRequestId: options?.orchestrationRequestId,
      originalCommand: ['orca', 'orchestration', 'send', '--type', 'worker_done']
    }
  )
}

describe('callOrchestrationMutation runtime_unavailable retry', () => {
  it.each([
    ['a fresh', new Map<string, string | boolean>(), expect.stringMatching(/^[0-9a-f-]{36}$/)],
    [
      'an explicit --retry-request',
      new Map([['retry-request', '11111111-2222-4333-8444-555555555555']]),
      '11111111-2222-4333-8444-555555555555'
    ]
  ])('retries with %s request id until the runtime answers', async (_case, flags, requestId) => {
    vi.useFakeTimers()
    const { client, requestIds } = fakeClient((attempt, options) => {
      if (attempt < 3) {
        throw unavailable(options)
      }
      return { ok: true, result: 'sent' }
    })
    const call = callOrchestrationMutation(
      client,
      flags,
      'orchestration.send',
      WORKER_DONE,
      undefined,
      RETRY_MS
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(call).resolves.toEqual({ ok: true, result: 'sent' })
    expect(requestIds).toHaveLength(3)
    expect(new Set(requestIds).size).toBe(1)
    expect(requestIds[0]).toEqual(requestId)
  })

  it('does not retry an error other than runtime_unavailable', async () => {
    const { client, requestIds } = fakeClient(() => {
      throw new RuntimeClientError('runtime_timeout', 'Timed out.')
    })
    await expect(
      callOrchestrationMutation(
        client,
        new Map(),
        'orchestration.send',
        WORKER_DONE,
        undefined,
        RETRY_MS
      )
    ).rejects.toMatchObject({ code: 'runtime_timeout' })
    expect(requestIds).toHaveLength(1)
  })

  it('does not retry mutations that did not opt in', async () => {
    const { client, requestIds } = fakeClient((_attempt, options) => {
      throw unavailable(options)
    })
    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.send', WORKER_DONE)
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
    expect(requestIds).toEqual([undefined])
  })

  it('keeps the recovery command when the last attempt fails before its request id is attached', async () => {
    vi.useFakeTimers()
    const { client, requestIds } = fakeClient((attempt, options) => {
      throw attempt === 1
        ? unavailable(options)
        : new RuntimeClientError('runtime_unavailable', 'No runtime metadata.')
    })
    const settled = callOrchestrationMutation(
      client,
      new Map(),
      'orchestration.send',
      WORKER_DONE,
      undefined,
      RETRY_MS
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(RETRY_MS + 30_000)
    expect(await settled).toMatchObject({
      data: { recovery: { orchestrationRequestId: requestIds[0] } }
    })
  })

  it('gives up after about two minutes and prints the recovery command with the same id', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const { client, requestIds } = fakeClient((_attempt, options) => {
      throw unavailable(options)
    })
    const call = callOrchestrationMutation(
      client,
      new Map(),
      'orchestration.send',
      WORKER_DONE,
      undefined,
      RETRY_MS
    )
    let finishedAt: number | undefined
    const settled = call.catch((error: unknown) => {
      finishedAt = Date.now()
      return error
    })
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    if (finishedAt === undefined) {
      throw new Error('mutation kept retrying beyond its two-minute budget')
    }
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(RETRY_MS - 15_000)
    const attempts = requestIds.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requestIds).toHaveLength(attempts)
    const error = await settled
    expect(new Set(requestIds).size).toBe(1)
    expect(error).toMatchObject({
      code: 'runtime_unavailable',
      data: {
        recovery: {
          retryCommand: [
            'orca',
            'orchestration',
            'send',
            '--type',
            'worker_done',
            '--retry-request',
            requestIds[0]
          ]
        }
      }
    })
  })

  // Windows cannot use this temporary Unix socket path.
  it.skipIf(process.platform === 'win32')(
    'reaches a runtime that comes back after the first attempt found it down',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-worker-done-retry-'))
      tempDirs.add(userDataPath)
      const endpoint = join(userDataPath, 'runtime.sock')
      const sendRequestIds: string[] = []
      const server = createServer((socket) => {
        socket.setEncoding('utf8')
        socket.once('data', (line: string) => {
          const request = RuntimeRequest.parse(JSON.parse(line.trim()))
          if (request.method === 'orchestration.send') {
            sendRequestIds.push(String(request.orchestrationRequestId))
            if (sendRequestIds.length === 1) {
              // Dropping the connection mid-request leaves the mutation outcome unknown.
              socket.destroy()
              return
            }
          }
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result:
                request.method === 'status.get'
                  ? { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] }
                  : { message: { id: 'msg_1' } },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        })
      })
      servers.add(server)
      const client = new RuntimeClient(userDataPath, 5_000, null, null, 'orca')
      const call = callOrchestrationMutation(
        client,
        new Map(),
        'orchestration.send',
        WORKER_DONE,
        undefined,
        RETRY_MS
      )
      // Initial attempts have no metadata, so the contract probe fails until this runtime starts.
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeFileSync(
        join(userDataPath, 'orca-runtime.json'),
        JSON.stringify({
          runtimeId: 'runtime-1',
          pid: 1,
          transports: [{ kind: 'unix', endpoint }],
          authToken: 'token',
          startedAt: 1
        })
      )
      await expect(call).resolves.toMatchObject({ result: { message: { id: 'msg_1' } } })
      expect(sendRequestIds).toHaveLength(2)
      expect(sendRequestIds[1]).toBe(sendRequestIds[0])
    },
    15_000
  )

  // Windows cannot use this temporary Unix socket path.
  const RETRY_ID = '11111111-2222-4333-8444-555555555555'
  it.skipIf(process.platform === 'win32').each([
    ['a fresh worker_done says nothing was sent', [], /Nothing was sent/],
    [
      'a --retry-request rerun keeps the outcome uncertain',
      ['--retry-request', RETRY_ID],
      /may already have taken effect/
    ],
    [
      'a credential-bearing worker_done says nothing was sent without printing it',
      ['--dispatch-capability', 'cap-secret'],
      /^(?![\s\S]*(cap-secret|request-show))[\s\S]*Nothing was sent[\s\S]*the same original command with --retry-request [0-9a-f-]{36}/
    ]
  ])(
    'when a frozen runtime times out the contract probe, %s',
    async (_case, extraArgs, outcomeText) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-worker-done-frozen-'))
      tempDirs.add(userDataPath)
      const endpoint = join(userDataPath, 'runtime.sock')
      const methods: string[] = []
      // A frozen runtime accepts the connection but never answers.
      const server = createServer((socket) => {
        socket.setTimeout(1_000, () => socket.destroy())
        socket.setEncoding('utf8')
        socket.once('data', (line: string) => {
          methods.push(RuntimeRequest.parse(JSON.parse(line.trim())).method)
        })
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeFileSync(
        join(userDataPath, 'orca-runtime.json'),
        JSON.stringify({
          runtimeId: 'runtime-1',
          pid: 1,
          transports: [{ kind: 'unix', endpoint }],
          authToken: 'token',
          startedAt: 1
        })
      )
      const argv = ['orchestration', 'send', '--type', 'worker_done', '--subject', 'done']
      const client = new RuntimeClient(userDataPath, 60_000, null, null, 'orca', [
        ...argv,
        ...extraArgs
      ])
      const retryRequest = extraArgs[0] === '--retry-request' ? extraArgs[1] : undefined
      const flags = new Map<string, string | boolean>(
        retryRequest ? [['retry-request', retryRequest]] : []
      )
      const error = await callOrchestrationMutation(
        client,
        flags,
        'orchestration.send',
        WORKER_DONE,
        { timeoutMs: 200 },
        RETRY_MS
      ).catch((caught: unknown) => caught)
      expect(methods).toEqual(['status.get'])
      expect(error).toMatchObject({
        code: 'runtime_timeout',
        message: expect.stringMatching(outcomeText),
        data: {
          recovery: extraArgs.includes('--dispatch-capability')
            ? { recoveryBlocked: true, disposition: 'not_sent' }
            : {
                retryCommand: [
                  'orca',
                  ...argv,
                  '--retry-request',
                  retryRequest ?? expect.stringMatching(/^[0-9a-f-]{36}$/)
                ]
              }
        }
      })
    },
    15_000
  )
})
