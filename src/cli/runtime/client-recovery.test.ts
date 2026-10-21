import { createServer, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS } from '../../shared/orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { orchestrationMutationRecoveryError } from '../orchestration-mutation-recovery'
import { reportCliError } from '../format'
import { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'

const servers = new Set<Server>()

afterEach(async () => {
  vi.restoreAllMocks()
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

function writeRuntimeConnection(userDataPath: string, endpoint: string, runtimeId: string): void {
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId,
      pid: 1,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    })
  )
}

function expectPromptRetryBlockedJson(error: unknown, requestId: string): void {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  reportCliError(error, true)
  const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
    error: { data?: Record<string, unknown> }
  }
  expect(output.error.data).toMatchObject({
    deliveryOutcome: 'unknown',
    retrySafe: false,
    nextSteps: expect.arrayContaining([
      'Inspect the terminal output and agent state without sending input.'
    ])
  })
  expect(JSON.stringify(output)).not.toContain('--retry-request')
  expect(JSON.stringify(output)).not.toContain(requestId)
  expect(output.error.data).not.toHaveProperty('orchestrationRequestId')
}

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
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-1')

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

  it('keeps durable prompt retry when failure metadata proves the preflight runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-current-prompt-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'runtime_timeout', message: 'request timed out' },
            _meta: { runtimeId: 'runtime-current' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-current')

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    const error = await client
      .call(
        'terminal.send',
        {
          terminal: 'term-current',
          text: 'review',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        {
          terminalPromptPreflight: { runtimeId: 'runtime-current' },
          orchestrationRequestId: 'prompt-current'
        }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RuntimeRpcFailureError)
    expect(error).toMatchObject({
      data: { orchestrationRequestId: 'prompt-current' }
    })
    expect((error as Error).message).toContain('--retry-request prompt-current')
  })

  it('keeps the prompt retry ID when the attested runtime times out in transport', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rt-timeout-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let receivedRequest: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        receivedRequest = JSON.parse(String(data).trim()) as Record<string, unknown>
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-current')

    const client = new RuntimeClient(userDataPath, 200, null, null, 'orca')
    const error = await client
      .call(
        'terminal.send',
        {
          terminal: 'term-current',
          text: 'review',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        {
          terminalPromptPreflight: { runtimeId: 'runtime-current' },
          orchestrationRequestId: 'prompt-transport-timeout'
        }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(receivedRequest?.orchestrationRequestId).toBe('prompt-transport-timeout')
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error).not.toBeInstanceOf(RuntimeRpcFailureError)
    expect((error as RuntimeClientError).code).toBe('runtime_timeout')
    expect(error).toMatchObject({ data: { orchestrationRequestId: 'prompt-transport-timeout' } })
    expect((error as Error).message).toContain(
      '--retry-request prompt-transport-timeout --wait-submit <seconds>'
    )
    expect((error as RuntimeClientError).data).not.toHaveProperty('retrySafe')
  })

  it('blocks retry when a downgraded runtime rejects after capability preflight', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-downgraded-prompt-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let receivedRequest: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as Record<string, unknown>
        receivedRequest = request
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'runtime_timeout', message: 'request timed out' },
            _meta: { runtimeId: 'runtime-after-downgrade' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-after-downgrade')

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    const error = await client
      .call(
        'terminal.send',
        {
          terminal: 'term-downgraded',
          text: 'review',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        {
          terminalPromptPreflight: { runtimeId: 'runtime-before-downgrade' },
          orchestrationRequestId: 'prompt-downgraded-rejection'
        }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(receivedRequest?.orchestrationRequestId).toBe('prompt-downgraded-rejection')
    expect(error).toBeInstanceOf(RuntimeRpcFailureError)
    expectPromptRetryBlockedJson(error, 'prompt-downgraded-rejection')
  })

  it('blocks retry when a downgraded runtime loses the prompt reply', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-lost-prompt-reply-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let receivedRequest: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as Record<string, unknown>
        receivedRequest = request
        socket.destroy()
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-after-downgrade')

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    const error = await client
      .call(
        'terminal.send',
        {
          terminal: 'term-downgraded',
          text: 'review',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        {
          terminalPromptPreflight: { runtimeId: 'runtime-before-downgrade' },
          orchestrationRequestId: 'prompt-downgraded-lost-reply'
        }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(receivedRequest?.orchestrationRequestId).toBe('prompt-downgraded-lost-reply')
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error).not.toBeInstanceOf(RuntimeRpcFailureError)
    expectPromptRetryBlockedJson(error, 'prompt-downgraded-lost-reply')
    expect(JSON.stringify((error as RuntimeClientError).data)).not.toContain('Update Orca')
  })

  it('reports an unknown legacy prompt outcome without advertising an unsafe retry', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-legacy-prompt-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let receivedRequest: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        receivedRequest = JSON.parse(String(data).trim()) as Record<string, unknown>
        socket.destroy()
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeRuntimeConnection(userDataPath, endpoint, 'runtime-legacy')

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    const error = await client
      .call(
        'terminal.send',
        {
          terminal: 'term-legacy',
          text: 'review',
          enter: true,
          interrupt: false,
          agentPrompt: true,
          client: { id: 'orca-cli', type: 'desktop' }
        },
        { legacyTerminalPrompt: true }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error).not.toBeInstanceOf(RuntimeRpcFailureError)
    expect(error).toMatchObject({
      data: {
        deliveryOutcome: 'unknown',
        retrySafe: false,
        nextSteps: expect.arrayContaining([
          'Inspect the terminal output and agent state without sending input.',
          'Update Orca on the execution host before future prompt sends that need durable retry.'
        ])
      }
    })
    expect((error as RuntimeClientError).data).not.toHaveProperty('orchestrationRequestId')
    expect(receivedRequest).not.toHaveProperty('orchestrationRequestId')
    expect((error as Error).message).not.toContain('--retry-request')
    expect((error as Error).message).toContain('do not resend automatically')
  })
})
