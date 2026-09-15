import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('DaemonPtyAdapter quick-command spawn payload', () => {
  let dir: string
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let socketPath: string
  let tokenPath: string

  beforeEach(async () => {
    lastSubprocess = createMockSubprocess()
    harness = await startDaemonAdapterHarness(() => lastSubprocess)
    dir = harness.dir
    adapter = harness.adapter
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
  })

  afterEach(async () => {
    adapter.dispose()
    await harness.server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards quickCommandSubmission in createOrAttach for daemon-hosted quick commands', async () => {
    const ensureConnectedSpy = vi
      .spyOn(DaemonClient.prototype, 'ensureConnected')
      .mockResolvedValue()
    const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
      isNew: true,
      pid: null,
      shellState: 'unsupported',
      snapshot: null
    } as never)
    const isolated = new DaemonPtyAdapter({ socketPath, tokenPath })
    try {
      await isolated.spawn({
        sessionId: 'quick-command-session',
        cols: 80,
        rows: 24,
        command: 'echo one\necho two\n',
        quickCommandSubmission: true,
        env: { SHELL: '/bin/zsh' }
      })
      const createPayload = requestSpy.mock.calls.find(([type]) => type === 'createOrAttach')?.[1]
      expect(createPayload).toMatchObject({
        command: 'echo one\necho two\n',
        quickCommandSubmission: true
      })
    } finally {
      isolated.dispose()
      requestSpy.mockRestore()
      ensureConnectedSpy.mockRestore()
    }
  })

  itOnPosix(
    'daemon-hosted quick commands preserve trailing LF inside bracketed paste submissions',
    async () => {
      const command = 'echo one\necho two\n'
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command,
        quickCommandSubmission: true,
        startupCommandDelivery: 'shell-ready',
        env: { SHELL: '/bin/zsh' }
      })

      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(lastSubprocess.write).not.toHaveBeenCalled()

      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07')
      lastSubprocess._simulateData('\r\nuser@host $ ')

      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledWith(`\x1b[200~${command}\x1b[201~\n`)
    }
  )
})
