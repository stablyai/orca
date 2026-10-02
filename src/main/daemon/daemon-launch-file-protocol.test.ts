import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { LAUNCH_FILE_DAEMON_PROTOCOL_VERSION, PROTOCOL_VERSION } from './daemon-protocol-version'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { carryInLaunchFile } from '../../shared/launch-prompt-file'

describe('a launch file sent to a terminal daemon', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    ;({ dir, socketPath, tokenPath, server, adapter } = harness)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a protocol the current daemon speaks', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(LAUNCH_FILE_DAEMON_PROTOCOL_VERSION)
  })

  // Why: only a session an older daemon still runs routes to it, so the spawn attaches; it must never
  // type a line naming a file that daemon would not write, and it must not refuse the attach.
  it('is withheld, with its command, from a daemon older than launch files', async () => {
    vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
    const request = vi
      .spyOn(DaemonClient.prototype, 'request')
      .mockResolvedValue({ isNew: false, snapshot: null, pid: 1 })
    const legacy = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      protocolVersion: LAUNCH_FILE_DAEMON_PROTOCOL_VERSION - 1
    })
    const { prompt, launchFile } = carryInLaunchFile('the whole task')
    try {
      await legacy
        .spawn({
          sessionId: 'legacy-launch',
          cols: 80,
          rows: 24,
          command: `claude '${prompt}'`,
          launchAgent: 'claude',
          launchFile
        })
        .catch(() => undefined)
      const createCall = request.mock.calls.find(([method]) => method === 'createOrAttach')
      expect(createCall?.[1]).toMatchObject({ sessionId: 'legacy-launch' })
      expect(createCall?.[1]).not.toHaveProperty('launchFile')
      expect(createCall?.[1]).toMatchObject({ command: undefined })
    } finally {
      legacy.dispose()
    }
  })

  it('is sent to the current daemon, which writes it', async () => {
    const request = vi.spyOn(DaemonClient.prototype, 'request')
    const { prompt, launchFile } = carryInLaunchFile('the whole task')
    await adapter.spawn({
      cols: 80,
      rows: 24,
      command: `claude '${prompt}'`,
      launchAgent: 'claude',
      launchFile
    })
    const createCall = request.mock.calls.find(([method]) => method === 'createOrAttach')
    expect(createCall?.[1]).toMatchObject({ launchFile: { placeholder: launchFile.placeholder } })
  })
})
