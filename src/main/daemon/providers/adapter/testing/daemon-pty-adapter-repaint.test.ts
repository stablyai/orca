import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonServer } from '../../../server/daemon-server'
import type { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

describe.skipIf(process.platform === 'win32')('DaemonPtyAdapter.requestRepaint', () => {
  let harness: DaemonAdapterHarness | undefined
  let server: DaemonServer | undefined
  let subprocess: ReturnType<typeof createMockSubprocess>

  async function start(protocolVersion?: number): Promise<DaemonPtyAdapter> {
    harness = await startDaemonAdapterHarness(
      () => {
        subprocess = createMockSubprocess()
        return subprocess
      },
      protocolVersion === undefined ? {} : { protocolVersion }
    )
    server = harness.server
    return harness.adapter
  }

  afterEach(async () => {
    harness?.adapter.dispose()
    await server?.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = undefined
    server = undefined
  })

  it('has the session resize its PTY one row smaller and back', async () => {
    const adapter = await start()
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    vi.mocked(subprocess.resize).mockClear()
    await adapter.requestRepaint(id)
    await vi.waitFor(
      () =>
        expect(vi.mocked(subprocess.resize).mock.calls).toEqual([
          [80, 23],
          [80, 24]
        ]),
      {
        timeout: 2_000
      }
    )
  })

  it('asks nothing of a daemon that predates the request', async () => {
    const adapter = await start(59)
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const resize = vi.mocked(subprocess.resize)
    resize.mockClear()
    await adapter.requestRepaint(id)
    // Why no wait: a daemon that is asked shrinks the PTY before it answers.
    expect(resize).not.toHaveBeenCalled()
  })
})
