import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readWsFallbackPort } from './rpc/ws-fallback-port-store'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const holders: Server[] = []

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map((holder) => new Promise<void>((resolve) => holder.close(() => resolve())))
  )
})

async function occupyLoopbackPort(): Promise<number> {
  const holder = createServer()
  holders.push(holder)
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const address = holder.address()
  if (!address || typeof address === 'string') {
    throw new Error('holder did not bind a TCP port')
  }
  return address.port
}

function boundWsPort(server: OrcaRuntimeRpcServer): number | null {
  const endpoint = server.getWebSocketEndpoint()
  return endpoint ? Number(new URL(endpoint).port) : null
}

describe('OrcaRuntimeRpcServer required WebSocket port', () => {
  it('fails startup instead of falling back when the required port is taken', async () => {
    const port = await occupyLoopbackPort()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: port,
      preferPinnedWsPort: true,
      requirePinnedWsPort: true
    })

    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(boundWsPort(server)).toBeNull()
      expect(readWsFallbackPort(userDataPath)).toBeUndefined()
      // Why: the failed start must also release the Unix socket it opened first, or the endpoint leaks.
      expect(readdirSync(userDataPath).filter((name) => name.endsWith('.sock'))).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('still falls back for a pinned but not required port', async () => {
    const port = await occupyLoopbackPort()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: port,
      preferPinnedWsPort: true
    })

    await server.start()
    try {
      const resolvedPort = boundWsPort(server)
      expect(resolvedPort).not.toBe(port)
      expect(readWsFallbackPort(userDataPath)).toBe(resolvedPort)
    } finally {
      await server.stop()
    }
  })
})
