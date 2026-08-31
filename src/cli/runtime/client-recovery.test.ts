import { createServer, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS } from '../../shared/orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { orchestrationMutationRecoveryError } from '../orchestration-mutation-recovery'
import { RuntimeClient, RuntimeRpcFailureError } from '../runtime-client'

const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

describe('RuntimeClient orchestration recovery identity', () => {
  it('rejects a worker-start timeout whose client grace would overflow timers', () => {
    const client = new RuntimeClient(undefined, 60_000, null, null, 'orca')
    const resolve = (
      client as unknown as {
        resolveMethodTimeoutMs: (method: string, params?: unknown) => number
      }
    ).resolveMethodTimeoutMs.bind(client)
    const maxValid = MAX_TIMER_DELAY_MS - ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
    expect(resolve('orchestration.workerStart', { timeoutMs: maxValid })).toBe(MAX_TIMER_DELAY_MS)
    expect(() => resolve('orchestration.workerStart', { timeoutMs: maxValid + 1 })).toThrow(
      'derived timeout must be'
    )
  })

  it('attaches the request and exact retry identity to a real RPC failure response', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-recovery-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) {
          return
        }
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string }
        const response =
          request.method === 'status.get'
            ? {
                id: request.id,
                ok: true,
                result: { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] },
                _meta: { runtimeId: 'runtime-1' }
              }
            : {
                id: request.id,
                ok: false,
                error: {
                  code: 'runtime_timeout',
                  message: 'request timed out',
                  data: { requestId: 'request_1', dispatchId: 'dispatch_1' }
                },
                _meta: { runtimeId: 'runtime-1' }
              }
        socket.end(`${JSON.stringify(response)}\n`)
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

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    try {
      await client.call('orchestration.workerStart', { task: 'task_1' })
      throw new Error('expected worker-start failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRpcFailureError)
      const recovered = orchestrationMutationRecoveryError(error) as {
        data?: Record<string, unknown>
        response?: { id?: string; _meta?: { runtimeId?: string } }
      }
      expect(recovered).toBeInstanceOf(RuntimeRpcFailureError)
      expect(recovered.response).toMatchObject({
        id: expect.any(String),
        _meta: { runtimeId: 'runtime-1' }
      })
      expect(recovered.data).toMatchObject({
        orchestrationRequestId: expect.any(String),
        dispatchId: 'dispatch_1',
        originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_1'],
        recovery: {
          queryCommand: [
            'orca',
            'orchestration',
            'worker-show',
            '--dispatch',
            'dispatch_1',
            '--json'
          ],
          retryCommand: [
            'orca',
            'orchestration',
            'worker-start',
            '--task',
            'task_1',
            '--retry-request',
            expect.any(String)
          ],
          recoveryBlocked: false
        }
      })
    }
  })
})
