import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonClient } from './client'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonServer } from './daemon-server'
import {
  APP_OSC133_ZONES_DAEMON_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
} from './daemon-protocol-version'
import { waitFor } from './daemon-pty-adapter-test-harness'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
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
    terminateOwnedTree: () => 'unavailable' as const,
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

  it.each([
    {
      legacyProtocol: STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION - 1,
      currentProtocol: STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
    },
    {
      legacyProtocol: APP_OSC133_ZONES_DAEMON_PROTOCOL_VERSION - 1,
      currentProtocol: PROTOCOL_VERSION
    }
  ])(
    'reattaches a live v$legacyProtocol pane through a v$currentProtocol router without replacing it',
    verifyLivePaneUpgrade
  )

  async function verifyLivePaneUpgrade({
    legacyProtocol,
    currentProtocol
  }: {
    legacyProtocol: number
    currentProtocol: number
  }): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-pty-upgrade-adoption-'))
    directories.push(directory)
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
      sessionId: `v${legacyProtocol}-stable-pane`,
      cols: 80,
      rows: 24
    })
    legacySubprocesses[0]?.emitData('output-before-upgrade')
    await oldAppAdapter['client'].request('setSessionBackground', {
      sessionId: original.id,
      background: true
    })
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
      snapshot: expect.stringContaining('output-before-upgrade')
    })
    expect(legacySubprocesses).toHaveLength(1)
    expect(currentSubprocesses).toHaveLength(0)
    router.write(original.id, 'input-after-upgrade')
    await vi.waitFor(() =>
      expect(legacySubprocesses[0]?.write).toHaveBeenCalledWith('input-after-upgrade')
    )

    const notify = vi.spyOn(DaemonClient.prototype, 'notify')
    const finished = vi.fn()
    const tracker = createTerminalTitleTracker({ onCommandFinished: finished })
    let output = ''
    const unsubscribe = router.onData(({ id, data }) => {
      if (id === original.id) {
        output += data
        tracker.handleChunk(data)
      }
    })
    try {
      router.setPtyBackgrounded(original.id, true)
      expect(notify).toHaveBeenCalledWith('setSessionBackground', {
        sessionId: original.id,
        background: false
      })
      const transcript = readFileSync(
        join(__dirname, '../runtime/__fixtures__/omp-user-bubble-osc133-zone.txt'),
        'utf8'
      )
      // The host answers and removes the fixture's background-colour query before delivery.
      const expectedOutput = transcript.replaceAll('\x1b]11;?\x07', '')
      legacySubprocesses[0]?.emitData(transcript)
      await waitFor(() => output.length >= expectedOutput.length)
      expect(output).toBe(expectedOutput)
      expect(finished).not.toHaveBeenCalled()
      legacySubprocesses[0]?.emitData('\x1b]133;D;0\x07\x1b]133;A\x07$ ')
      await waitFor(() => finished.mock.calls.length === 1)

      await router.spawn({ sessionId: 'fresh-session', cols: 80, rows: 24 })
      expect(legacySubprocesses).toHaveLength(1)
      expect(currentSubprocesses).toHaveLength(1)
    } finally {
      unsubscribe()
      tracker.dispose()
      notify.mockRestore()
    }
  }
})
