import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const FALLBACK_FILE = 'mobile-ws-fallback-port.json'

describe('OrcaRuntimeRpcServer WebSocket fallback port (#15490)', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function holdPort(): Promise<number> {
    const holder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    await holder.start()
    cleanups.push(() => holder.stop())
    return holder.resolvedPort
  }

  async function freePort(): Promise<number> {
    const scratch = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    await scratch.start()
    const port = scratch.resolvedPort
    await scratch.stop()
    return port
  }

  async function startServer(userDataPath: string, wsPort: number): Promise<number> {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort
    })
    await server.start()
    cleanups.push(() => server.stop())
    return Number(new URL(server.getWebSocketEndpoint() ?? '').port)
  }

  it('drops a persisted fallback that no longer binds and serves the preferred port', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-fallback-'))
    const takenFallback = await holdPort()
    writeFileSync(join(userDataPath, FALLBACK_FILE), JSON.stringify({ port: takenFallback }))
    const preferred = await freePort()

    await expect(startServer(userDataPath, preferred)).resolves.toBe(preferred)
    expect(existsSync(join(userDataPath, FALLBACK_FILE))).toBe(false)
  })
})
