import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'
import {
  COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS,
  LONG_POLL_CLIENT_GRACE_MS,
  resolveMethodTimeoutMs
} from './runtime-request-timeout'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
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

describe.skipIf(process.platform === 'win32')('RuntimeClient timeout policy', () => {
  it('does not crash while resolving terminal.wait defaults without params', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { satisfied: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 100)
    const response = await client.call<{ satisfied: boolean }>('terminal.wait')

    expect(response.result).toEqual({ satisfied: true })
  })
})

describe('resolveMethodTimeoutMs', () => {
  it('gives collaborationCheckpoint wait=true an explicit timeoutMs plus grace', () => {
    expect(
      resolveMethodTimeoutMs(
        'orchestration.collaborationCheckpoint',
        { wait: true, timeoutMs: 5_000 },
        10_000
      )
    ).toBe(5_000 + LONG_POLL_CLIENT_GRACE_MS)
  })

  it('uses the default collaboration wait budget plus grace when wait=true omits timeoutMs', () => {
    expect(
      resolveMethodTimeoutMs('orchestration.collaborationCheckpoint', { wait: true }, 10_000)
    ).toBe(COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS + LONG_POLL_CLIENT_GRACE_MS)
  })

  it('keeps the default budget even when the client is configured below 60s', () => {
    expect(
      resolveMethodTimeoutMs('orchestration.collaborationCheckpoint', { wait: true }, 1_000)
    ).toBeGreaterThanOrEqual(COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS)
  })

  it('never shortens below the client request timeout', () => {
    expect(
      resolveMethodTimeoutMs(
        'orchestration.collaborationCheckpoint',
        { wait: true, timeoutMs: 1_000 },
        120_000
      )
    ).toBe(120_000)
  })

  it('applies the default budget for a non-finite or non-positive timeoutMs', () => {
    for (const timeoutMs of [0, -5, Number.NaN, 'nope']) {
      expect(
        resolveMethodTimeoutMs(
          'orchestration.collaborationCheckpoint',
          { wait: true, timeoutMs },
          10_000
        )
      ).toBe(COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS + LONG_POLL_CLIENT_GRACE_MS)
    }
  })

  it('uses the ordinary request timeout for a non-wait checkpoint', () => {
    for (const params of [undefined, {}, { wait: false }, { timeoutMs: 5_000 }]) {
      expect(resolveMethodTimeoutMs('orchestration.collaborationCheckpoint', params, 25_000)).toBe(
        25_000
      )
    }
  })

  it('leaves orchestration.check wait=true behavior unchanged (no default budget)', () => {
    expect(resolveMethodTimeoutMs('orchestration.check', { wait: true }, 10_000)).toBe(10_000)
    expect(
      resolveMethodTimeoutMs('orchestration.check', { wait: true, timeoutMs: 5_000 }, 10_000)
    ).toBe(5_000 + LONG_POLL_CLIENT_GRACE_MS)
  })

  it('leaves terminal.wait behavior unchanged (no default budget)', () => {
    expect(resolveMethodTimeoutMs('terminal.wait', undefined, 10_000)).toBe(10_000)
    expect(resolveMethodTimeoutMs('terminal.wait', { timeoutMs: 5_000 }, 10_000)).toBe(
      5_000 + LONG_POLL_CLIENT_GRACE_MS
    )
  })
})
