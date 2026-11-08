import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonServer } from '../../../server/daemon-server'
import type { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
// 1.4.251 shipped v55 without the request; 1.4.252 added it inside v55.
const UNVERSIONED_FOCUS_LOSS_PROTOCOL_VERSION = 55

describe('DaemonPtyAdapter.reportFocusLost', () => {
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

  async function focusedSession(adapter: DaemonPtyAdapter): Promise<string> {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    subprocess._simulateData('\x1b[?1004h')
    adapter.write(id, FOCUS_IN)
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledWith(FOCUS_IN))
    return id
  }

  /** Stands in for a daemon whose router predates the request and rejects it as unknown. */
  function rejectFocusLossReports(daemon: DaemonServer): ReturnType<typeof vi.fn> {
    const router =
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for an older daemon's router, whose default branch rejects unknown types.
      (daemon as unknown as { requestRouter: { route: (...args: never[]) => unknown } })
        .requestRouter
    const route = router.route.bind(router)
    const rejected = vi.fn()
    router.route = (clientId: never, request: never) => {
      const { type } = request as { type: string }
      if (type === 'reportFocusLost') {
        rejected()
        throw new Error(`Unknown request type: ${type}`)
      }
      return route(clientId, request)
    }
    return rejected
  }

  it('tells the program focus is gone', async () => {
    const adapter = await start()
    const id = await focusedSession(adapter)

    await adapter.reportFocusLost(id)

    expect(subprocess.write).toHaveBeenLastCalledWith(FOCUS_OUT)
  })

  it('never asks a daemon from before the request existed', async () => {
    const adapter = await start(UNVERSIONED_FOCUS_LOSS_PROTOCOL_VERSION - 1)
    const id = await focusedSession(adapter)
    const rejected = rejectFocusLossReports(server!)

    await expect(adapter.reportFocusLost(id)).resolves.toBeUndefined()

    expect(rejected).not.toHaveBeenCalled()
  })

  it('stops asking a v55 daemon that rejects the request, but asks its replacement', async () => {
    const adapter = await start(UNVERSIONED_FOCUS_LOSS_PROTOCOL_VERSION)
    const firstId = await focusedSession(adapter)
    const rejected = rejectFocusLossReports(server!)

    await expect(adapter.reportFocusLost(firstId)).resolves.toBeUndefined()
    await expect(adapter.reportFocusLost(firstId)).resolves.toBeUndefined()
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(subprocess.write).not.toHaveBeenCalledWith(FOCUS_OUT)

    // A v55 daemon from a later build accepts the request at the same endpoint.
    const firstIdentity = adapter.getLastAuthenticatedDaemonIdentity()
    await server!.shutdown()
    server = new DaemonServer({
      socketPath: harness!.socketPath,
      tokenPath: harness!.tokenPath,
      protocolVersion: UNVERSIONED_FOCUS_LOSS_PROTOCOL_VERSION,
      launchNonce: 'replacement-launch',
      startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
      log: harness!.daemonLog,
      spawnSubprocess: () => {
        subprocess = createMockSubprocess()
        return subprocess
      }
    })
    await server.start()
    await vi.waitFor(async () => {
      await adapter.listProcesses()
      expect(adapter.getLastAuthenticatedDaemonIdentity()?.launchNonce).toBe('replacement-launch')
    })
    const replacementId = await focusedSession(adapter)

    await adapter.reportFocusLost(replacementId)

    expect(subprocess.write).toHaveBeenLastCalledWith(FOCUS_OUT)
  })
})
