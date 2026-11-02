import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../providers/pty-process-inspection'
import { isClientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
import { probePtyRunningWorkWithInspection } from '../../shared/pty-running-work-probe'

// After a relaunch every WSL bridge pane the window had not reopened read
// `unverifiable`, so no move could pass its terminal gate.
describe('inspecting a session that survived a relaunch unattached', () => {
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

  // With one daemon generation, the relaunched app's provider is the adapter itself.
  async function relaunchWithSession(): Promise<{ provider: DaemonPtyAdapter; id: string }> {
    const { id } = await quittingApp.spawn({ cols: 80, rows: 24, sessionId: 'wt@@idle' })
    quittingApp.dispose()
    relaunchedApp = new DaemonPtyAdapter({ socketPath, tokenPath })
    // The relaunched runtime adopts surviving sessions from this inventory; no window attaches.
    expect((await relaunchedApp.listProcesses()).map((entry) => entry.id)).toEqual([id])
    return { provider: relaunchedApp, id }
  }

  it('answers the WSL move gate from the daemon', async () => {
    const { provider, id } = await relaunchWithSession()
    const inspection = await inspectPtyProviderProcessForRenderer(provider, id, {
      scanChildProcesses: true,
      includeUnattached: true
    })
    expect(isClientOnlyUnverifiableInspection(inspection)).toBe(false)
    expect(inspection.hasChildProcesses).toBe(false)
  })

  it('still reads as gone to every other caller', async () => {
    const { provider, id } = await relaunchWithSession()
    const inspection = await inspectPtyProviderProcessForRenderer(provider, id, {
      scanChildProcesses: true
    })
    expect(isClientOnlyUnverifiableInspection(inspection)).toBe(true)
  })

  it('reads a session the daemon no longer runs as unverifiable even for the gate', async () => {
    const { provider, id } = await relaunchWithSession()
    subprocesses[0]!._simulateExit(0)
    const probe = (): Promise<string | undefined> =>
      probePtyRunningWorkWithInspection([id], { timeoutMs: 3_000 }, (ptyId) =>
        inspectPtyProviderProcessForRenderer(provider, ptyId, { includeUnattached: true })
      ).then(([result]) => result?.verdict)
    await vi.waitFor(async () => expect(await probe()).toBe('unverifiable'))
  })

  // Loss of contact is never evidence of exit.
  it('reads an unreachable daemon as unverifiable, never exited', async () => {
    const { provider, id } = await relaunchWithSession()
    await server.shutdown()
    const [result] = await probePtyRunningWorkWithInspection([id], { timeoutMs: 3_000 }, (ptyId) =>
      inspectPtyProviderProcessForRenderer(provider, ptyId, { includeUnattached: true })
    )
    expect(result?.verdict).toBe('unverifiable')
  })
})
