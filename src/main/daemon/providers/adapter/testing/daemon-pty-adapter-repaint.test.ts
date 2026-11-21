import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonServer } from '../../../server/daemon-server'
import type { DaemonPtyAdapter } from '../daemon-pty-adapter'
import type { SubprocessHandle } from '../../../sessions/session-subprocess-handle'
import { repaintResultOf } from '../../checkpointing/daemon-pty-buffer-snapshots'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

describe.skipIf(process.platform === 'win32')('DaemonPtyAdapter.requestRepaint', () => {
  let harness: DaemonAdapterHarness | undefined
  let server: DaemonServer | undefined
  let subprocess: ReturnType<typeof createMockSubprocess>

  async function start(
    protocolVersion?: number,
    extra: Partial<SubprocessHandle> = {}
  ): Promise<DaemonPtyAdapter> {
    harness = await startDaemonAdapterHarness(
      () => {
        subprocess = Object.assign(createMockSubprocess(), extra)
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
    expect(await adapter.requestRepaint(id)).toBe('nudged')
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

  it('passes on a daemon that answers it could not ask', async () => {
    const adapter = await start(undefined, { resizeRedrawsOwnScreen: true })
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    vi.mocked(subprocess.resize).mockClear()
    expect(await adapter.requestRepaint(id)).toBe('unavailable')
    expect(subprocess.resize).not.toHaveBeenCalled()
  })

  it('asks nothing of a daemon that predates the request', async () => {
    const adapter = await start(59)
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const resize = vi.mocked(subprocess.resize)
    resize.mockClear()
    // Its main then tells the coordinator the mail is held.
    expect(await adapter.requestRepaint(id)).toBe('unavailable')
    // Why no wait: a daemon that is asked shrinks the PTY before it answers.
    expect(resize).not.toHaveBeenCalled()
  })
})

describe('repaint answer from a daemon before v62', () => {
  it('reads the missing answer as a nudge everywhere but Windows, which it skipped', () => {
    expect(repaintResultOf({}, 'win32')).toBe('unavailable')
    expect(repaintResultOf(undefined, 'darwin')).toBe('nudged')
    expect(repaintResultOf({ nudged: true }, 'win32')).toBe('nudged')
    expect(repaintResultOf({ nudged: false }, 'linux')).toBe('unavailable')
  })
})
