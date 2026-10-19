import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('daemon inventory of a pane closed just before quit', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let quittingApp: DaemonPtyAdapter
  let relaunchedApp: DaemonPtyAdapter | null = null
  const subprocesses: ReturnType<typeof createMockSubprocess>[] = []

  beforeEach(async () => {
    subprocesses.length = 0
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      // Why: a shell inside its kill grace -- it exits only when the test says so.
      vi.mocked(subprocess.kill).mockImplementation(() => {})
      vi.mocked(subprocess.forceKill).mockImplementation(() => {})
      subprocesses.push(subprocess)
      return subprocess
    })
    ;({ dir, socketPath, tokenPath, server } = harness)
    quittingApp = harness.adapter
  })

  afterEach(async () => {
    for (const subprocess of subprocesses) {
      subprocess._simulateExit(0)
    }
    quittingApp.dispose()
    relaunchedApp?.dispose()
    relaunchedApp = null
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports the closed pane as live but exiting to the relaunched app, then gone', async () => {
    const kept = await quittingApp.spawn({ cols: 80, rows: 24, sessionId: 'wt@@kept' })
    const closed = await quittingApp.spawn({ cols: 80, rows: 24, sessionId: 'wt@@closed' })

    const shutdown = quittingApp.shutdown(closed.id, { immediate: true })
    await vi.waitFor(() => expect(subprocesses[1]!.forceKill).toHaveBeenCalled())
    // Quit before the daemon has finished the kill.
    quittingApp.dispose()
    await shutdown.catch(() => {})

    relaunchedApp = new DaemonPtyAdapter({ socketPath, tokenPath })
    const listed = await relaunchedApp.listProcesses()
    expect(listed).toContainEqual(expect.objectContaining({ id: closed.id, exiting: true }))
    expect(listed.find((entry) => entry.id === kept.id)).not.toHaveProperty('exiting')

    subprocesses[1]!._simulateExit(0)
    await vi.waitFor(async () =>
      expect((await relaunchedApp!.listProcesses()).map((entry) => entry.id)).toEqual([kept.id])
    )
  })
})
