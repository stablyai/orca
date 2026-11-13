import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonServer } from '../../../server/daemon-server'
import type { DaemonFileLog } from '../../../observability/daemon-file-log'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from '../../../health/daemon-health'
import type * as DaemonTccAttributionModule from '../../../permissions/daemon-tcc-attribution'
import type * as DaemonBundleStalenessModule from '../../../launch/daemon-bundle-staleness'

const {
  getMacDaemonSystemResolverHealthMock,
  getMacDaemonTccAttributionHealthMock,
  isDaemonStaleForCurrentBundleMock
} = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(
    async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
  ),
  getMacDaemonTccAttributionHealthMock: vi.fn(
    async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
  ),
  isDaemonStaleForCurrentBundleMock: vi.fn(async () => false)
}))

vi.mock('../../../health/daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('../../../permissions/daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

vi.mock('../../../launch/daemon-bundle-staleness', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonBundleStalenessModule>()
  return {
    ...actual,
    isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock
  }
})

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let daemonLog: DaemonFileLog

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    daemonLog = harness.daemonLog
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
    isDaemonStaleForCurrentBundleMock.mockReset()
    isDaemonStaleForCurrentBundleMock.mockResolvedValue(false)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('dead-endpoint write respawn (STA-2373)', () => {
    function restartServerOnRespawn(): void {
      server = new DaemonServer({
        socketPath,
        tokenPath,
        log: daemonLog,
        spawnSubprocess: () => {
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
    }

    it('signals every active pane and respawns as soon as the daemon dies, before any input', async () => {
      const respawn = vi.fn(async () => {
        restartServerOnRespawn()
        await server.start()
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      const recovered: string[] = []
      healingAdapter.onWriteUnavailable(({ id }) => recovered.push(id))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await healingAdapter.spawn({ sessionId: 'pane-a', cols: 80, rows: 24 })
        await healingAdapter.spawn({ sessionId: 'pane-b', cols: 80, rows: 24 })

        await server.shutdown()

        // Waiting for a keystroke would lose that input and leave stale output visible.
        await waitFor(() => recovered.includes('pane-a') && recovered.includes('pane-b'))
        await waitFor(() => respawn.mock.calls.length === 1)
        await healingAdapter.spawn({ sessionId: 'pane-a', cols: 80, rows: 24 })
        expect(() => healingAdapter.write('pane-a', 'after-recovery')).not.toThrow()
        expect(respawn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
        healingAdapter.dispose()
      }
    })
  })
})
