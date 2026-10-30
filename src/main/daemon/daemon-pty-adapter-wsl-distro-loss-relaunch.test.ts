// 5e: a bridge pane whose distro was terminated must cold-restore its own session after a relaunch.
import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'
import { DaemonServer } from './daemon-server'
import { WslBridgeBootIdentity } from './daemon-wsl-bridge-boot-identity'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

/** Drives the adapter's own periodic save, which has no public trigger. */
class SavingDaemonPtyAdapter extends DaemonPtyAdapter {
  savePeriodically(sessionIds: string[]): Promise<unknown> {
    return this.checkpointSessions(sessionIds, { final: false })
  }

  /** What a spawn in `\\wsl.localhost\Ubuntu\...` records, without faking win32. */
  runsInUbuntu(sessionId: string): void {
    this.noteSpawnWslDistro(sessionId, 'Ubuntu', false)
  }
}

const PANE = 'wt-1::/project@@bridge'
const OTHER = 'wt-2::/other@@native'
const WORKTREES = new Set(['wt-1::/project', 'wt-2::/other'])

describe('a WSL bridge pane whose distro was terminated, after a relaunch', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let historyDir: string
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  const spawnSubprocess = () => {
    lastSubprocess = createMockSubprocess()
    return lastSubprocess
  }

  const reaped = new Set<string>()

  beforeEach(async () => {
    reaped.clear()
    const harness = await startDaemonAdapterHarness(
      spawnSubprocess,
      {},
      {
        onPtySessionExit: (sessionId) => reaped.add(sessionId)
      }
    )
    harness.adapter.dispose()
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    historyDir = join(dir, 'history')
  })
  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const launch = (
    options: Pick<DaemonPtyAdapterOptions, 'readRunningWslDistros' | 'wslBridgeBootIdentity'> = {}
  ) => new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir, ...options })

  /** A bridge pane with saved history, beside a native pane that keeps the daemon running. */
  async function openBridgePane(app: SavingDaemonPtyAdapter) {
    await app.spawn({ cols: 80, rows: 24, cwd: '/other', sessionId: OTHER })
    await app.spawn({ cols: 80, rows: 24, cwd: '/project', sessionId: PANE })
    app.runsInUbuntu(PANE)
    const bridge = lastSubprocess
    bridge._simulateData('user@host:~/project$ echo KEPT\r\nKEPT\r\nuser@host:~/project$ ')
    await app.savePeriodically([PANE])
    return bridge
  }

  async function relaunchAndRestore(): Promise<boolean> {
    const app = launch()
    await app.reconcileOnStartup(WORKTREES)
    const restored = await app.spawn({ cols: 80, rows: 24, cwd: '/project', sessionId: PANE })
    await app.disconnectOnly()
    return Boolean(restored.coldRestore)
  }

  it('restores when the distro stopped while Orca was quit and the daemon kept running', async () => {
    const app = launch()
    const bridge = await openBridgePane(app)
    await app.disconnectOnly()

    bridge._simulateExit(1)
    // The relaunch must find no session to attach to, only the history to restore.
    await vi.waitFor(() => expect(reaped.has(PANE)).toBe(true))

    await expect(relaunchAndRestore()).resolves.toBe(true)
  })

  it('restores when the distro stopped while Orca was quit and the daemon exited with it', async () => {
    const app = launch()
    await app.spawn({ cols: 80, rows: 24, cwd: '/project', sessionId: PANE })
    lastSubprocess._simulateData('user@host:~/project$ echo KEPT\r\nKEPT\r\n')
    await app.savePeriodically([PANE])
    await app.disconnectOnly()

    lastSubprocess._simulateExit(1)
    // Its last session gone and no client, the daemon exits; the relaunch starts a new one.
    await server.shutdown()
    server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess })
    await server.start()

    await expect(relaunchAndRestore()).resolves.toBe(true)
  })

  it.each([
    [
      'something booted the distro again before the running list answered',
      [{ status: 'confirmed', distros: ['Ubuntu'] }],
      ['boot-1', 'boot-2']
    ],
    [
      'the first running list could not answer',
      [{ status: 'unavailable' }, { status: 'confirmed', distros: [] }],
      ['boot-1']
    ]
  ] as const)('restores when %s while Orca ran', async (_name, answers, ids) => {
    const reads: WslRunningDistrosRead[] = answers.map((answer) => ({
      ...answer,
      ...('distros' in answer ? { distros: [...answer.distros] } : {})
    }))
    const bootIds = [...ids]
    const app = launch({
      readRunningWslDistros: async () => (reads.length > 1 ? reads.shift()! : reads[0]!),
      wslBridgeBootIdentity: new WslBridgeBootIdentity({
        isRunning: async () => true,
        readBootId: async () => (bootIds.length > 1 ? bootIds.shift()! : bootIds[0]!)
      })
    })
    const exits: unknown[] = []
    app.onExit((exit) => exits.push(exit))
    const bridge = await openBridgePane(app)

    bridge._simulateExit(1)
    await vi.waitFor(() => expect(exits).toEqual([expect.objectContaining({ hostLost: true })]))
    await app.disconnectOnly()

    await expect(relaunchAndRestore()).resolves.toBe(true)
  })
})
