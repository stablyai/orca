import { readFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

import { extractAllOscTitleEntries } from '../../../../shared/agent-status/title/osc-title-extraction'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import { paneKeyPtyId, ptyPaneKey, rememberPaneKeyForPty } from '../../../ipc/pty/pane/key-state'
import { mainProcessState } from '../../../startup/main-process-state'
import { driveSyntheticTitleFromHookStatus } from '../../../startup/synthetic-title-runtime'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from '../../orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'

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
  it('delivers mail to a live Codex behind a fresh done hook and a stale spinner', async () => {
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
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('delivers mail to a program that reports its status but never sets a title', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-titleless-program-status-')
    const { runtime, write } = createRuntime(db, { launchAgent: 'antigravity' })
    const run = createBoundRun(db, 'Titleless Run')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=working:app=antigravity\x07', 1)
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=done:app=antigravity\x07> ', 2)
    insertDirectRunMessage(db, run.id, 'Worker done')
    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('Pi controlled hooks preserve titleless and native-title panes', async () => {
    vi.useFakeTimers()
    const { runtime, status, dispose } = producerFixture('pi')
    try {
      // Pi 0.74.0/Linux capture, 2026-10-16; adjacent .meta.json records provenance.
      const capture = readFileSync(
        new URL('../../__fixtures__/pi-0-74-late-kitty-esc-cr.txt', import.meta.url),
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
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBeNull()
      status('working')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBeNull()
      await expect(runtime.getTerminalAgentStatus(TERMINAL_HANDLE)).resolves.toMatchObject({
        status: 'working'
      })
      runtime.onPtyData(PTY_ID, nativeFrame, 1)
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('π - work')
      status('done')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('π - work')
      status('working')
      expect(runtime.getTrackedPtyTitle(PTY_ID)).toBe('π - work')
    } finally {
      await dispose()
    }
  })
})
