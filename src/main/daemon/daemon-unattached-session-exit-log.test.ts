import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

describe('daemon.log records a terminal exit no client heard', () => {
  let harness: DaemonAdapterHarness | null = null
  const adapters: DaemonPtyAdapter[] = []

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = null
  })

  async function start() {
    const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
    harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    const log = vi.spyOn(harness.daemonLog, 'log')
    const exitLines = () => log.mock.calls.filter(([event]) => event === 'session-exited')
    return { harness, subprocesses, exitLines }
  }

  it('logs it once when the pane was not reopened since a relaunch', async () => {
    const { harness, subprocesses, exitLines } = await start()
    const sessionId = 'wt-1::/project@@pane1'
    const first = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    adapters.push(first)
    await first.spawn({ cols: 80, rows: 24, cwd: '/project', sessionId })
    // Quit: the desktop lets go of the terminal, which keeps running in the daemon.
    await first.disconnectOnly()
    const relaunched = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    adapters.push(relaunched)
    expect((await relaunched.listSessions()).map((session) => session.sessionId)).toEqual([
      sessionId
    ])

    // Its distro stops before the user opens the tab again.
    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exitLines().length > 0)
    expect(exitLines()).toEqual([['session-exited', { sessionId, code: 1, attached: false }]])
  })

  it('leaves an exit an attached client heard to that client, so it is logged once', async () => {
    const { harness, subprocesses, exitLines } = await start()
    const exits: unknown[] = []
    harness.adapter.onExit((exit) => exits.push(exit))
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24, cwd: '/project' })

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exitLines()).toEqual([
      ['session-exited', expect.objectContaining({ sessionId: id, code: 1 })]
    ])
    expect(exitLines()[0]![1]).not.toHaveProperty('attached')
  })
})
