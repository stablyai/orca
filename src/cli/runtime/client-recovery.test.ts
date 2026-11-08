import { createServer, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../shared/protocol-version'
import '../orchestration-mutation-recovery'
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
})
