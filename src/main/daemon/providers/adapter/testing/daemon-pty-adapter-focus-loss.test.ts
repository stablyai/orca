import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonServer } from '../../../server/daemon-server'
import type { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

describe('DaemonPtyAdapter.reportFocusLost', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function focusedSession(): Promise<string> {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    subprocess._simulateData('\x1b[?1004h')
    adapter.write(id, FOCUS_IN)
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledWith(FOCUS_IN))
    return id
  }

  it('tells the program focus is gone', async () => {
    const id = await focusedSession()

    await adapter.reportFocusLost(id)

    expect(subprocess.write).toHaveBeenLastCalledWith(FOCUS_OUT)
  })

  it('leaves a daemon that predates the request, and its session, working', async () => {
    const id = await focusedSession()
    const router =
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for an older daemon's router, whose default branch rejects unknown types.
      (server as unknown as { requestRouter: { route: (...args: never[]) => unknown } })
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

    await expect(adapter.reportFocusLost(id)).resolves.toBeUndefined()
    await expect(adapter.reportFocusLost(id)).resolves.toBeUndefined()
    adapter.write(id, 'ls\n')

    await vi.waitFor(() => expect(subprocess.write).toHaveBeenLastCalledWith('ls\n'))
    expect(subprocess.write).not.toHaveBeenCalledWith(FOCUS_OUT)
    // The rejection is remembered for this client, so no further requests reach the old daemon.
    expect(rejected).toHaveBeenCalledTimes(1)
  })
})
