import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'issue-8335-repro-'))
}

function createMockSubprocess(): SubprocessHandle & {
  _simulateData: (data: string) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  return {
    pid: 999_999_999,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      void cb
    },
    dispose() {},
    _simulateData(data: string) {
      onDataCb?.(data)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('issue #8335 repro: reconnect reattaches live daemon PTYs', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    dir = createTestDir()
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => {
        lastSubprocess = createMockSubprocess()
        return lastSubprocess
      }
    })
    await server.start()
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
  })

  afterEach(async () => {
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('restores live output after the client socket reconnects', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'issue-8335' })
    const dataPayloads: { id: string; data: string }[] = []
    adapter.onData((payload) => dataPayloads.push(payload))
    const internals = adapter as unknown as {
      client: DaemonClient
      ensureConnected: () => Promise<void>
    }

    internals.client.disconnect()
    await internals.ensureConnected()

    lastSubprocess._simulateData('restored-after-reconnect')
    await waitFor(() => dataPayloads.length > 0)
    expect(dataPayloads.at(-1)).toEqual({
      id,
      data: 'restored-after-reconnect'
    })
  })
})
