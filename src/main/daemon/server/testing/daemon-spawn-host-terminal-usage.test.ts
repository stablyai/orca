import '../../pty-subprocess/testing/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../transport/client/daemon-client'
import { DaemonServer } from '../daemon-server'
import { getDaemonSocketPath } from '../../launch/daemon-spawner'
import { HostTerminalPolicy } from '../../admission/host-terminal-policy'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import type { DaemonCreateOrAttachResult } from '../../protocol/daemon-create-or-attach-result'

function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44446,
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

// A start reads its host's terminal count off its own spawn reply, so no daemon request of its own.
describe.skipIf(process.platform === 'win32')('spawn reply host terminal usage', () => {
  let dir: string
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-usage-'))
    const socketPath = getDaemonSocketPath(dir)
    const tokenPath = join(dir, 'test.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess(),
      // Its own ledger, so no other daemon on this machine is counted.
      hostTerminalLedgerDir: join(dir, 'terminals'),
      terminalLimitPolicy: new HostTerminalPolicy(null, { ORCA_DAEMON_MAX_HOST_TERMINALS: '5' })
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

  const spawn = (sessionId: string) =>
    client.request<DaemonCreateOrAttachResult>('createOrAttach', { sessionId, cols: 80, rows: 24 })

  it('counts each new spawn against the cap, and a reattach reports none', async () => {
    expect((await spawn('first')).hostTerminalUsage).toEqual({ terminalsInUse: 1, maxTerminals: 5 })
    expect((await spawn('second')).hostTerminalUsage).toEqual({
      terminalsInUse: 2,
      maxTerminals: 5
    })
    expect((await spawn('first')).hostTerminalUsage).toBeUndefined()
  })
})
