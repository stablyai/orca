import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'

type FixtureSubprocess = SubprocessHandle & { emitData: (data: string) => void }

function createFixtureSubprocess(pid: number): FixtureSubprocess {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn((callback) => {
      onData = callback
    }),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn(),
    emitData: (data) => onData?.(data)
  }
}

describe('daemon PTY upgrade adoption', () => {
  const servers: DaemonServer[] = []
  const adapters: DaemonPtyAdapter[] = []
  const directories: string[] = []
  let router: DaemonPtyRouter | null = null

  afterEach(async () => {
    router?.dispose()
    router = null
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await Promise.all(servers.splice(0).map((server) => server.shutdown()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reattaches a live v30 pane through a v31 router without spawning a replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-pty-upgrade-adoption-'))
    directories.push(directory)
    const legacyProtocol = STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION - 1
    const currentProtocol = STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    const legacySocketPath = getDaemonSocketPath(directory, legacyProtocol)
    const currentSocketPath = getDaemonSocketPath(directory, currentProtocol)
    const legacyTokenPath = join(directory, 'legacy.token')
    const currentTokenPath = join(directory, 'current.token')
    const log: DaemonFileLog = { log: () => {}, close: () => {} }
    const legacySubprocesses: FixtureSubprocess[] = []
    const currentSubprocesses: FixtureSubprocess[] = []
    const legacyServer = new DaemonServer({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: legacyProtocol,
      log,
      spawnSubprocess: () => {
        const subprocess = createFixtureSubprocess(30_030)
        legacySubprocesses.push(subprocess)
        return subprocess
      }
    })
    const currentServer = new DaemonServer({
      socketPath: currentSocketPath,
      tokenPath: currentTokenPath,
      protocolVersion: currentProtocol,
      log,
      spawnSubprocess: () => {
        const subprocess = createFixtureSubprocess(31_031)
        currentSubprocesses.push(subprocess)
        return subprocess
      }
    })
    servers.push(legacyServer, currentServer)
    await Promise.all([legacyServer.start(), currentServer.start()])

    const oldAppAdapter = new DaemonPtyAdapter({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: legacyProtocol
    })
    adapters.push(oldAppAdapter)
    const original = await oldAppAdapter.spawn({
      sessionId: 'v30-stable-pane',
      cols: 80,
      rows: 24
    })
    legacySubprocesses[0]?.emitData('output-before-v31-upgrade')
    oldAppAdapter.dispose()

    const legacyAdapter = new DaemonPtyAdapter({
      socketPath: legacySocketPath,
      tokenPath: legacyTokenPath,
      protocolVersion: legacyProtocol
    })
    const currentAdapter = new DaemonPtyAdapter({
      socketPath: currentSocketPath,
      tokenPath: currentTokenPath,
      protocolVersion: currentProtocol
    })
    adapters.push(legacyAdapter, currentAdapter)
    router = new DaemonPtyRouter({ current: currentAdapter, legacy: [legacyAdapter] })
    await router.discoverLegacySessions()

    const adopted = await router.spawn({
      sessionId: original.id,
      cols: 120,
      rows: 40,
      attachOnly: true,
      command: 'must-not-run'
    })

    expect(adopted).toMatchObject({
      id: original.id,
      incarnationId: original.incarnationId,
      isReattach: true,
      snapshot: expect.stringContaining('output-before-v31-upgrade')
    })
    expect(legacySubprocesses).toHaveLength(1)
    expect(currentSubprocesses).toHaveLength(0)
    router.write(original.id, 'input-after-v31-upgrade')
    await vi.waitFor(() =>
      expect(legacySubprocesses[0]?.write).toHaveBeenCalledWith('input-after-v31-upgrade')
    )
  })
})
