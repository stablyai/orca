import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

/** Drives the adapter's own periodic save, which has no public trigger. */
class SavingDaemonPtyAdapter extends DaemonPtyAdapter {
  savePeriodically(sessionIds: string[]): Promise<unknown> {
    return this.checkpointSessions(sessionIds, { final: false })
  }
}

describe('daemon history across a wake and a relaunch', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

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
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  // awin verify-15a: Sleep, Wake, quit and relaunch, then Sleep put the new prompt on the old one.
  it('keeps the fresh-shell padding in history after a wake, periodic saves and a relaunch', async () => {
    const historyDir = join(dir, 'history')
    const prompt = 'user@host:~/project$ '
    const sessionId = 'wt-1::/project@@wake1'
    const checkpointRows = async () => {
      const saved = JSON.parse(
        readFileSync(
          join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json'),
          'utf8'
        )
      )
      const terminal = new Terminal({
        cols: 47,
        rows: 44,
        scrollback: 5000,
        allowProposedApi: true
      })
      await new Promise<void>((resolve) => terminal.write(saved.snapshotAnsi, resolve))
      const rows: string[] = []
      for (let i = 0; i < terminal.buffer.active.length; i++) {
        rows.push(terminal.buffer.active.getLine(i)?.translateToString(true).trimEnd() ?? '')
      }
      terminal.dispose()
      return rows
    }
    let history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const save = (adapter: SavingDaemonPtyAdapter) => adapter.savePeriodically([sessionId])

    await history.spawn({ cols: 47, rows: 44, cwd: '/project', sessionId })
    lastSubprocess._simulateData(`${prompt}echo BEFORE\r\nBEFORE\r\n${prompt}`)
    await history.shutdown(sessionId, { immediate: true, keepHistory: true })
    await history.spawn({ cols: 47, rows: 44, cwd: '/project', sessionId })
    history.ackColdRestore(sessionId)
    lastSubprocess._simulateData(`${prompt}echo AFTER\r\nAFTER\r\n${prompt}`)
    await save(history)
    await history.disconnectOnly()

    history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    await history.reconcileOnStartup(new Set([parsePtySessionId(sessionId).worktreeId ?? '']))
    await save(history)

    const rows = await checkpointRows()
    const restoredPrompt = rows.indexOf('BEFORE') + 1
    expect(rows[restoredPrompt]).toBe(prompt.trimEnd())
    expect(rows[restoredPrompt + 1]).toBe('')
    expect(rows.filter((row) => row.split(prompt.trimEnd()).length > 2)).toEqual([])
    expect(rows.filter((row) => row !== '')).toEqual([
      `${prompt}echo BEFORE`,
      'BEFORE',
      prompt.trimEnd(),
      `${prompt}echo AFTER`,
      'AFTER',
      prompt.trimEnd()
    ])
    history.dispose()
  })
})
