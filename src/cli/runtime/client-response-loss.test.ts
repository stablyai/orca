import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'
import { attachSlowMutationCompletionWarning } from './client-response-loss'
import { RuntimeClientError } from './types'

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

function endpoint(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\orca-t7410-client-${process.pid}-${randomUUID()}`
    : join(mkdtempSync(join(tmpdir(), 'orca-runtime-client-response-loss-')), 'runtime.sock')
}

describe('RuntimeClient response-loss recovery', () => {
  it('marks a sent slow mutation as possibly completed', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-response-loss-'))
    const server = createServer((socket) => {
      socket.once('data', () => socket.end())
    })
    const socketEndpoint = endpoint()
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(socketEndpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [
          { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint: socketEndpoint }
        ],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 2_000)
    await expect(
      client.call('worktree.create', { repo: 'id:repo', name: 'slow-create' })
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof RuntimeClientError &&
        error.code === 'runtime_unavailable' &&
        error.data !== null &&
        typeof error.data === 'object' &&
        (error.data as Record<string, unknown>).requestPhase === 'awaiting_response' &&
        (error.data as Record<string, unknown>).mutationMayHaveCompleted === true &&
        error.message.includes('may have completed')
      )
    })
  })

  it('describes a timeout as an incomplete response instead of a closed connection', () => {
    const error = attachSlowMutationCompletionWarning(
      new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.',
        {
          requestPhase: 'awaiting_response'
        }
      ),
      'worktree.create'
    )

    expect(error).toMatchObject({
      code: 'runtime_timeout',
      message: expect.stringContaining('before the runtime responded')
    })
    expect((error as RuntimeClientError).message).not.toContain('connection closed')
  })
})
