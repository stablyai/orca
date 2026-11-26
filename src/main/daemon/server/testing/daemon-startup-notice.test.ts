import '../../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../transport/client/daemon-client'
import { DaemonServer } from '../daemon-server'
import { getDaemonSocketPath } from '../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44447,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: exit,
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
}

// Main decides a launch notice (Claude's root bypass); the daemon that owns the pane must show it.
describe.skipIf(process.platform === 'win32')('daemon startup notice', () => {
  let dir: string
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-notice-'))
    const socketPath = getDaemonSocketPath(dir)
    const tokenPath = join(dir, 'test.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess(),
      hostTerminalLedgerDir: join(dir, 'terminals')
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
  })

  afterEach(async () => {
    client.disconnect()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the notice of a fresh startup command into the pane', async () => {
    await client.request('createOrAttach', {
      sessionId: 'notice',
      cols: 80,
      rows: 24,
      command: 'claude',
      launchAgent: 'claude',
      startupNotice: '[orca] root notice'
    })
    await expect
      .poll(async () => {
        const read = await client.request<{ snapshot: { snapshotAnsi: string } | null }>(
          'getSnapshot',
          { sessionId: 'notice' }
        )
        return read.snapshot?.snapshotAnsi ?? ''
      })
      .toContain('[orca] root notice')
  })
})
