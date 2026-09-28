import './mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { DaemonSessionAttachments } from './daemon-session-attachments'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

it('does not recreate a released client attachment after an exit during spawn admission', async () => {
  let confirm!: () => void
  const receipt = new Promise<void>((resolve) => {
    confirm = resolve
  })
  let subscribed = false
  const subprocess = createMockSubprocess()
  const attach = vi.spyOn(DaemonSessionAttachments.prototype, 'attach')
  const release = vi.spyOn(DaemonSessionAttachments.prototype, 'release')
  const harness = await startDaemonAdapterHarness(async (opts) => {
    opts.onSpawnAttempt?.(
      () => subprocess,
      async () => {
        subprocess.forceKill()
      }
    )
    subscribed = true
    await receipt
    return subprocess
  })
  try {
    const pending = harness.adapter.spawn({ cols: 80, rows: 24, sessionId: 'early-exit' })
    await waitFor(() => subscribed)
    subprocess._simulateExit(7)
    confirm()
    await expect(pending).resolves.toMatchObject({ id: 'early-exit', exitedBeforeSpawnReply: true })
    expect(release).toHaveBeenCalledWith('early-exit')
    expect(attach).not.toHaveBeenCalled()
  } finally {
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})
