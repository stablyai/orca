import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  driveToLiveIdle,
  PTY_ID,
  WORKTREE_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { registerBoundPty } from '../../../orca-runtime-tests/bind-first-pane.test-fixture'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('owed mailbox foreground revalidation', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['unknown', 'consumed', 'retired'] as const)(
    'joins a slow inspection and stops the obligation when %s',
    async (outcome) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-slow-foreground-')
      const { runtime } = createRuntime(db)
      const write = vi.fn((_ptyId: string, _data: string) => true)
      let shell = true
      let pending: Promise<void> | undefined
      let release = (): void => {}
      const inspections: number[] = []
      const inspect = async () => {
        inspections.push(Date.now())
        const delayed = pending
        pending = undefined
        await delayed
        return shell
      }
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => 'codex',
        confirmShellForeground: inspect,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => ({
          foregroundProcess: shell ? 'zsh' : null,
          hasChildProcesses: !shell,
          foregroundObservation: (await inspect())
            ? {
                ptyId: PTY_ID,
                ptyIncarnationId: 'mailbox-incarnation',
                authorityGeneration: 'test',
                observationEpoch: 1,
                capturedAgeMs: 0,
                verdict: 'observed',
                source: 'pty-master',
                foregroundKind: 'shell',
                processName: 'zsh'
              }
            : undefined
        })
      })
      const run = createBoundRun(db, 'Slow foreground recovery')
      await driveToLiveIdle(runtime)
      const message = insertDirectRunMessage(db, run.id, 'Waiting mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      pending = new Promise((resolve) => {
        release = resolve
      })
      const before = inspections.length
      await vi.advanceTimersByTimeAsync(30000)
      expect(inspections.length - before).toBe(1)
      expect(write).not.toHaveBeenCalled()
      if (outcome === 'consumed') {
        db.markAsRead([message.id])
      } else if (outcome === 'retired') {
        runtime.onPtyExit(PTY_ID, 0)
      }
      shell = false
      release()
      await vi.advanceTimersByTimeAsync(1000)
      if (outcome === 'unknown') {
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message'),
          '\r'
        ])
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
      } else {
        expect(write).not.toHaveBeenCalled()
      }
      const settledCount = inspections.length
      await vi.advanceTimersByTimeAsync(30000)
      expect(inspections.length).toBe(settledCount)
      db.close()
    }
  )

  it.each([
    [10, 40],
    [100, 400]
  ])(
    'bounds automatic inspection chains for %i held terminals with owed mail',
    async (count, chainBound) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-foreground-fleet-')
      const { runtime } = createRuntime(db, { launchAgent: null })
      const write = vi.fn((_ptyId: string, _data: string) => true)
      const panes = Array.from({ length: count * 2 }, (_, index) => ({
        ptyId: `fleet-${index}`,
        tabId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        leafId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        handle: `term_fleet_${index}`
      }))
      for (const pane of panes) {
        registerBoundPty(runtime, pane.ptyId, WORKTREE_ID, null, {
          tabId: pane.tabId,
          leafId: pane.leafId,
          incarnationId: `inc-${pane.ptyId}`
        })
        runtime.registerPreAllocatedHandleForPty(pane.ptyId, pane.handle)
      }
      runtime.syncWindowGraph(1, {
        tabs: panes.map((pane) => ({
          tabId: pane.tabId,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: pane.leafId,
          layout: null
        })),
        leaves: panes.map((pane, index) => ({
          ...pane,
          worktreeId: WORKTREE_ID,
          paneRuntimeId: index + 1
        }))
      })
      await runtime.listTerminals()
      for (const pane of panes) {
        runtime.onPtyData(pane.ptyId, '\x1b]0;Codex done\x07', 1)
        await runtime.serializeMainTerminalBuffer(pane.ptyId)
      }
      await vi.advanceTimersByTimeAsync(1000)
      const starts: { ptyId: string; at: number }[] = []
      let active = 0
      let peak = 0
      const foreground = runtime.readLaunchedAgentForeground.bind(runtime)
      vi.spyOn(runtime, 'readLaunchedAgentForeground').mockImplementation(async (ptyId, agent) => {
        if (agent !== undefined) {
          return foreground(ptyId, agent)
        }
        starts.push({ ptyId, at: Date.now() })
        active++
        peak = Math.max(peak, active)
        try {
          return await foreground(ptyId)
        } finally {
          active--
        }
      })
      const inspect = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return true
      }
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => 'codex',
        confirmShellForeground: inspect,
        supportsForegroundObservation: () => true,
        inspectProcess: async (ptyId) => {
          await inspect()
          return {
            foregroundProcess: 'zsh',
            hasChildProcesses: false,
            foregroundObservation: {
              ptyId,
              ptyIncarnationId: `inc-${ptyId}`,
              authorityGeneration: 'test',
              observationEpoch: 1,
              capturedAgeMs: 0,
              verdict: 'observed',
              source: 'pty-master',
              foregroundKind: 'shell',
              processName: 'zsh'
            }
          }
        }
      })
      const owed = panes.slice(0, count)
      const messages = owed.map((pane) =>
        db.insertMessage({ from: 'term_sender', to: pane.handle, subject: 'Owed mail' })
      )
      for (const pane of owed) {
        runtime.notifyMessageArrived(pane.handle, 'message')
      }
      await vi.advanceTimersByTimeAsync(20000)
      expect(write).not.toHaveBeenCalled()
      // Four concurrent chains and >=5s after each completion: at most four starts per owner in 20s.
      expect(peak).toBeLessThanOrEqual(4)
      expect(starts.length).toBeGreaterThanOrEqual(count)
      expect(
        starts.length,
        JSON.stringify(
          starts
            .filter((start) => start.ptyId === owed[0].ptyId)
            .map((start) => start.at - starts[0].at)
        )
      ).toBeLessThanOrEqual(chainBound)
      expect(starts.every((start) => owed.some((pane) => pane.ptyId === start.ptyId))).toBe(true)
      expect(
        new Set(starts.filter((start) => start.at > starts[0].at + 5000).map((start) => start.at))
          .size
      ).toBeGreaterThan(1)
      db.markAsRead(messages.map((message) => message.id))
      await vi.advanceTimersByTimeAsync(10000)
      const retiredCount = starts.length
      await vi.advanceTimersByTimeAsync(20000)
      expect(starts.length).toBe(retiredCount)
      db.close()
    }
  )
})
