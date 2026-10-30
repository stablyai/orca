import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { extractAllOscTitleEntries } from '../../shared/osc-title-extraction'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { paneKeyPtyId, ptyPaneKey, rememberPaneKeyForPty } from '../ipc/pty/pane/key-state'
import { mainProcessState } from '../startup/main-process-state'
import { driveSyntheticTitleFromHookStatus } from '../startup/synthetic-title-runtime'
import { createLongPollServer } from './runtime-rpc-long-poll-server.test-fixture'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  LEAF_ID,
  PANE_KEY,
  PTY_ID,
  TAB_ID,
  TERMINAL_HANDLE,
  temporaryDirectories,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

function producerFixture(agentType: 'codex' | 'pi' = 'codex') {
  const db = createDatabase('orca-hook-title-contract-')
  const hook: AgentStatusIpcPayload = {
    paneKey: PANE_KEY,
    terminalHandle: TERMINAL_HANDLE,
    agentType,
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now()
  }
  const { runtime } = createRuntime(db, {
    launchAgent: agentType,
    getAgentStatusSnapshot: () => [hook]
  })
  const write = vi.fn((_ptyId: string, _data: string) => true)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => agentType
  })
  const previousRuntime = mainProcessState.runtime
  const previousPaneKey = ptyPaneKey.get(PTY_ID)
  const previousPtyId = paneKeyPtyId.get(PANE_KEY)
  const previousOtherPtyId = previousPaneKey ? paneKeyPtyId.get(previousPaneKey) : undefined
  mainProcessState.runtime = runtime
  rememberPaneKeyForPty(PTY_ID, PANE_KEY)
  const status = (state: 'done' | 'working') => {
    Object.assign(hook, { state, receivedAt: Date.now(), stateStartedAt: Date.now() })
    driveSyntheticTitleFromHookStatus({ paneKey: PANE_KEY, payload: hook })
  }
  const dispose = async () => {
    try {
      await runtime.onPtyExit(PTY_ID, 0)
    } finally {
      db.close()
      mainProcessState.runtime = previousRuntime
      if (previousPaneKey === undefined) {
        ptyPaneKey.delete(PTY_ID)
      } else {
        ptyPaneKey.set(PTY_ID, previousPaneKey)
      }
      if (previousPtyId === undefined) {
        paneKeyPtyId.delete(PANE_KEY)
      } else {
        paneKeyPtyId.set(PANE_KEY, previousPtyId)
      }
      if (previousPaneKey && previousPaneKey !== PANE_KEY && previousOtherPtyId !== undefined) {
        paneKeyPtyId.set(previousPaneKey, previousOtherPtyId)
      }
    }
  }
  return { db, runtime, write, status, dispose }
}

describe('hook title evidence and completion recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Synthetic: Codex's done hook, then a final native spinner that only the timer clears (#19243).
  it('delivers mail once the clear confirms a live Codex behind a fresh done hook', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-stale-title-completion-')
    const hook: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      agentType: 'codex',
      state: 'done',
      prompt: '',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    const { runtime } = createRuntime(db, { getAgentStatusSnapshot: () => [hook] })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: vi.fn(async () => 'codex')
    })
    const run = createBoundRun(db, 'Timer Run')
    await runtime.listTerminals()
    runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex ready\x07')
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ mobile-rearch\x07', 1)
    runtime.onPtyData(PTY_ID, 'composer repaint without a title', 2)
    insertDirectRunMessage(db, run.id, 'Worker progress')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('CLI waits through a silent titleless turn and delivers mail only after Stop', async () => {
    const { db, runtime, write, status, dispose } = producerFixture()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-title-wait-cli-'))
    temporaryDirectories.push(userDataPath)
    const server = createLongPollServer({ runtime, userDataPath, enableWebSocket: false })
    const exitCode = process.exitCode
    for (const name of ['ORCA_AGENT_SESSION_ID', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE']) {
      vi.stubEnv(name, '')
    }
    vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', TERMINAL_HANDLE)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // The source CLI has its own TS project; keep the real client import at the runtime boundary.
      const cliPath = '../../cli/index'
      const { main }: { main(argv: string[], cwd: string): Promise<void> } = await import(cliPath)
      const wait = async () => {
        output.mockClear()
        process.exitCode = 0
        await main(
          [
            'terminal',
            'wait',
            '--terminal',
            TERMINAL_HANDLE,
            '--for',
            'tui-idle',
            '--timeout-ms',
            '300',
            '--json'
          ],
          userDataPath
        )
        return JSON.parse(String(output.mock.calls.at(-1)?.[0]))
      }
      await server.start()
      const run = createBoundRun(db, 'Titleless Run')
      await runtime.listTerminals()
      status('done')
      await expect(
        runtime.sendTerminal(
          TERMINAL_HANDLE,
          { text: 'next prompt', enter: true },
          { inputKind: 'driving' }
        )
      ).resolves.toMatchObject({ accepted: true })
      write.mockClear()
      status('working')
      insertDirectRunMessage(db, run.id, 'Worker progress')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      runtime.onPtyData(PTY_ID, 'working without native titles\r\n', 1)
      // Real silence lets the production display timer fire; no output resets it.
      await new Promise((resolve) => setTimeout(resolve, 3_200))
      expect((await runtime.listTerminals()).terminals[0]?.title).toBe('Codex')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('⠋ Codex')
      expect(await wait()).toMatchObject({ ok: false, error: { code: 'timeout' } })
      expect(process.exitCode).toBe(1)
      expect(write).not.toHaveBeenCalled()

      status('done')
      expect(await wait()).toMatchObject({ ok: true, result: { wait: { satisfied: true } } })
      expect(process.exitCode).toBe(0)
      await expect
        .poll(() => write.mock.calls.map(([, data]) => data))
        .toEqual([expect.stringContaining('You have 1 orchestration message'), '\r'])
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      process.exitCode = exitCode ?? 0
      try {
        await server.stop()
      } finally {
        await dispose()
      }
    }
  }, 15_000)

  it('Pi controlled hooks retract rest and preserve a subsequently recorded native title', async () => {
    vi.useFakeTimers()
    const { runtime, status, dispose } = producerFixture('pi')
    try {
      // Pi 0.74.0/Linux capture, 2026-10-16; adjacent .meta.json records provenance.
      const capture = readFileSync(
        new URL('./__fixtures__/pi-0-74-late-kitty-esc-cr.txt', import.meta.url),
        'utf8'
      )
      const nativeTitle = extractAllOscTitleEntries(capture).find(({ title }) =>
        title.startsWith('π')
      )
      if (!nativeTitle) {
        throw new Error('Pi capture must contain its native OSC title')
      }
      const nativeFrame = capture.slice(
        capture.lastIndexOf('\x1b]', nativeTitle.end - 1),
        nativeTitle.end
      )
      await runtime.listTerminals()
      status('done')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('Pi ready')
      status('working')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('⠋ Pi')
      await expect(runtime.getTerminalAgentStatus(TERMINAL_HANDLE)).resolves.toMatchObject({
        status: 'working'
      })
      runtime.onPtyData(PTY_ID, nativeFrame, 1)
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('π - work')
      status('working')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('π - work')
    } finally {
      await dispose()
    }
  })

  it.each([20, 200])(
    'bounds semantic ingestion and snapshot tab visits at %i tabs',
    async (population) => {
      vi.useFakeTimers()
      const { runtime, status, dispose } = producerFixture()
      try {
        await runtime.listTerminals()
        status('done')
        await runtime.getTerminalAgentStatus(TERMINAL_HANDLE)
        await vi.advanceTimersByTimeAsync(1_000)
        runtime.mobileSessionTabsByWorktree.clear()
        let visits = 0
        for (const [group, worktree] of [WORKTREE_ID, 'unrelated-worktree'].entries()) {
          const tabs: RuntimeMobileSessionTabsSnapshot['tabs'] = Array.from(
            { length: population / 2 },
            (_, index) => {
              const target = group === 0 && index === population / 2 - 1
              return {
                type: 'terminal',
                id: target ? `${TAB_ID}::${LEAF_ID}` : `tab-${group}-${index}`,
                parentTabId: target ? TAB_ID : `parent-${group}-${index}`,
                leafId: target ? LEAF_ID : `leaf-${index}`,
                title: 'Codex',
                ptyId: target ? PTY_ID : `other-${group}-${index}`,
                isActive: false
              }
            }
          )
          const some = tabs.some.bind(tabs)
          vi.spyOn(tabs, 'some').mockImplementation((predicate, thisArg) =>
            some((tab, index, array) => {
              visits += 1
              return predicate.call(thisArg, tab, index, array)
            })
          )
          runtime.mobileSessionTabsByWorktree.set(worktree, {
            worktree,
            publicationEpoch: 'title-contract',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs
          })
        }
        const ingestion = vi.spyOn(runtime, 'ingestSyntheticTitleFrame')
        status('working')
        await vi.advanceTimersByTimeAsync(1_000)
        expect(ingestion).toHaveBeenCalledTimes(1)
        expect(ingestion).toHaveBeenCalledWith(PTY_ID, '\x1b]0;⠋ Codex\x07')
        expect(visits).toBeGreaterThanOrEqual(population)
        expect(visits).toBeLessThanOrEqual(4 * population)
        ingestion.mockClear()
        visits = 0
        for (let event = 0; event < 100; event += 1) {
          status('working')
        }
        await vi.advanceTimersByTimeAsync(1_000)
        expect(ingestion).not.toHaveBeenCalled()
        expect(visits).toBe(0)
      } finally {
        await dispose()
      }
    }
  )
})
