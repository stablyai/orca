import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { AGENT_PROMPT_BRACKETED_PASTE_START } from '../../shared/agent-prompt-injection'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  InMemoryOrchestrationMessages,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  setInMemoryOrchestrationMessages
} from './orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'

// The two halves of agent sleep-wake, exercised TOGETHER: a slept pane that is
// listable and addressable by handle must still wake when mail arrives for it.
// Each half passes in isolation — listing knows nothing about delivery, and the
// delivery unit test hands its dependency a handle that does not resolve — so
// only a runtime-level case can catch a listable pane taking a silent exit.
//
// Lives in a `.test.ts`: config/vitest.config.ts includes only `*.test.ts`, so a
// case placed in orca-runtime-tests/*.spec.ts would never run in CI.

const TAB_ID = 'tab-slept'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function sleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'coordinate the fleet',
    state: 'done',
    capturedAt: 1,
    updatedAt: 2,
    terminalTitle: 'coordinator',
    origin: 'worktree-sleep',
    ...overrides
  }
}

function sleptSession(record: SleepingAgentSessionRecord): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: TEST_WORKTREE_ID,
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

/** A pane whose agent auto-slept: the leaf survives in the renderer graph with no
 *  PTY, and persistence holds its resume record. */
async function sleptPaneRuntime(record: SleepingAgentSessionRecord): Promise<{
  runtime: InstanceType<typeof OrcaRuntimeService>
  db: InMemoryOrchestrationMessages
  handle: string
  resumable: boolean | undefined
  connected: boolean
  tabMountSends: unknown[][]
  write: ReturnType<typeof vi.fn>
  confirmForegroundProcess: ReturnType<typeof vi.fn>
  remountWithPty: (ptyId: string) => void
  remountStatuslessCodex: (ptyId: string, graphBeforeRegistration: boolean) => void
  setForegroundProcess: (process: string | null) => void
  setConfirmedForegroundProcess: (process: string | null | undefined) => void
  setForegroundConfirmationSupported: (supported: boolean) => void
  setRendererAvailable: (available: boolean) => void
}> {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(sleptSession(record))
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  const db = new InMemoryOrchestrationMessages()
  setInMemoryOrchestrationMessages(runtime, db)
  const write = vi.fn().mockReturnValue(true)
  let foregroundProcess: string | null = null
  let confirmedForegroundProcess: string | null | undefined
  let foregroundConfirmationSupported = true
  const confirmForegroundProcess = vi.fn(async () =>
    confirmedForegroundProcess === undefined ? foregroundProcess : confirmedForegroundProcess
  )
  runtime.setPtyController({
    write,
    kill: vi.fn(),
    getForegroundProcess: async () => foregroundProcess,
    confirmForegroundProcess,
    supportsForegroundProcessConfirmation: () => foregroundConfirmationSupported
  } as never)
  runtime.attachWindow(1)
  const syncGraph = (ptyId: string | null): void => {
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'coordinator',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: null
        }
      ]
    } as never)
  }
  syncGraph(null)

  const tabMountSends: unknown[][] = []
  let rendererAvailable = true
  vi.spyOn(
    runtime as unknown as { getAuthoritativeWindow: () => unknown },
    'getAuthoritativeWindow'
  ).mockImplementation(() => {
    if (!rendererAvailable) {
      throw new Error('renderer unavailable')
    }
    return {
      webContents: {
        send: (...args: unknown[]) => {
          if (args[0] === 'terminal:requestTabMount') {
            tabMountSends.push(args)
          }
        }
      }
    }
  })

  // The sender's own view of the pane: this is where the handle comes from, and
  // listing it is what registers the handle the send then addresses.
  const { terminals } = await runtime.listTerminals()
  const row = terminals.find((terminal) => terminal.tabId === TAB_ID)
  expect(row, 'the slept pane must be listed at all').toBeDefined()
  return {
    runtime,
    db,
    handle: row!.handle,
    resumable: row!.resumable,
    connected: row!.connected,
    tabMountSends,
    write,
    confirmForegroundProcess,
    setForegroundProcess: (process) => {
      foregroundProcess = process
    },
    setConfirmedForegroundProcess: (process) => {
      confirmedForegroundProcess = process
    },
    setForegroundConfirmationSupported: (supported) => {
      foregroundConfirmationSupported = supported
    },
    setRendererAvailable: (available) => {
      rendererAvailable = available
    },
    // What the renderer does with `terminal:requestTabMount`: the tab remounts and
    // its agent cold-restores into a fresh PTY that then reports a finished turn.
    remountWithPty: (ptyId: string) => {
      syncGraph(ptyId)
      runtime.onPtyData(ptyId, '\x1b]0;Claude working\x07', 100)
      runtime.onPtyData(ptyId, '\x1b]0;Claude done\x07', 101)
    },
    remountStatuslessCodex: (ptyId: string, graphBeforeRegistration: boolean) => {
      // Reattach registration and renderer graph publication race independently.
      if (graphBeforeRegistration) {
        syncGraph(ptyId)
      }
      runtime.onPtyData(ptyId, '\x1b]0;\u280b fixture\x07', 99)
      runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'codex-reattach-incarnation',
        providerReattachLaunchIdentity: {
          incarnationId: 'codex-reattach-incarnation',
          launchAgent: 'codex'
        }
      })
      runtime.onPtyData(
        ptyId,
        [
          ' >_ OpenAI Codex (v0.132.0)\n',
          ' model:       gpt-5.5 high   /model to change\n',
          ' directory:   ~/orca/workspaces/orca/impl-agent-sleep-wake\n',
          '\x1b]0;fixture\x07'
        ].join(''),
        100
      )
      if (!graphBeforeRegistration) {
        syncGraph(ptyId)
      }
    }
  }
}

describe('mail addressed to a listed slept pane', () => {
  it('retries a parked wake when the renderer graph becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, db, handle, tabMountSends, setRendererAvailable } =
        await sleptPaneRuntime(sleepingRecord())
      setRendererAvailable(false)
      db.insertMessage({ from: 'term_sender', to: handle, subject: 'wake up', type: 'status' })
      runtime.notifyMessageArrived(handle, 'status')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_500)
      expect(tabMountSends).toEqual([])

      setRendererAvailable(true)
      runtime.markGraphReady(1)
      await vi.advanceTimersByTimeAsync(1_500)

      expect(tabMountSends).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lose a wake sent while the renderer graph is reloading', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, db, handle, tabMountSends } = await sleptPaneRuntime(sleepingRecord())
      db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
      expect(runtime.markRendererReloading(1)).not.toBeNull()
      db.insertMessage({
        from: 'term_worker',
        to: 'run:run_test',
        subject: 'worker done',
        type: 'worker_done'
      })
      runtime.requestSleepingRecipientWake('run:run_test')
      await vi.advanceTimersByTimeAsync(1_500)

      expect(tabMountSends).toEqual([])

      runtime.markGraphReady(1)
      await vi.advanceTimersByTimeAsync(1_500)

      expect(tabMountSends).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('redrives a parked wake when a renderer graph reload is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, db, handle, tabMountSends } = await sleptPaneRuntime(sleepingRecord())
      db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
      const fence = runtime.markRendererReloading(1)
      if (!fence) {
        throw new Error('expected renderer reload fence')
      }
      db.insertMessage({
        from: 'term_worker',
        to: 'run:run_test',
        subject: 'worker done',
        type: 'worker_done'
      })
      runtime.requestSleepingRecipientWake('run:run_test')
      await vi.advanceTimersByTimeAsync(1_500)

      expect(tabMountSends).toEqual([])
      expect(runtime.markRendererReloadCancelled(1, fence)).toBe(true)
      await vi.advanceTimersByTimeAsync(1_500)

      expect(tabMountSends).toHaveLength(1)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes the pane the listing just made addressable', async () => {
    const { runtime, db, handle, resumable, connected, tabMountSends } =
      await sleptPaneRuntime(sleepingRecord())
    // Part 1: the pane is addressable — asleep, not absent.
    expect({ connected, resumable }).toEqual({ connected: false, resumable: true })

    db.insertMessage({ from: 'term_sender', to: handle, subject: 'wake up', type: 'status' })
    runtime.notifyMessageArrived(handle, 'status')
    await Promise.resolve()
    await Promise.resolve()

    // Part 3: the send promised a wake, so one must actually be asked for.
    expect(tabMountSends).toHaveLength(1)
    expect(tabMountSends[0]?.[1]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      tabId: TAB_ID,
      paneKey: PANE_KEY,
      intent: 'inbound-message'
    })
    db.close()
  })

  it('does not wake a pane from a delivery sweep with nothing in the mailbox', async () => {
    // Why: pty retirement redrives and restored-mailbox repoints run delivery
    // for empty mailboxes at the exact moment hibernation kills the pane.
    // Observed live: without the unread-mail gate, the kill itself scheduled a
    // wake and the pane respawned two seconds after sleeping.
    const { runtime, db, handle, tabMountSends } = await sleptPaneRuntime(sleepingRecord())
    runtime.deliverPendingMessagesForHandle(handle)
    await Promise.resolve()
    await Promise.resolve()

    expect(tabMountSends).toEqual([])
    db.close()
  })

  it('still refuses to wake a pane the user slept deliberately', async () => {
    const { runtime, db, handle, tabMountSends } = await sleptPaneRuntime(
      sleepingRecord({ restoreOnTabOpenOnly: true })
    )
    db.insertMessage({ from: 'term_sender', to: handle, subject: 'stay asleep', type: 'status' })
    runtime.notifyMessageArrived(handle, 'status')
    await Promise.resolve()
    await Promise.resolve()

    expect(tabMountSends).toEqual([])
    db.close()
  })

  it('wakes a slept coordinator addressed through its run mailbox', async () => {
    const { runtime, db, handle, tabMountSends } = await sleptPaneRuntime(sleepingRecord())
    db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
    db.insertMessage({
      from: 'term_worker',
      to: 'run:run_test',
      subject: 'worker done',
      type: 'worker_done'
    })
    runtime.notifyMessageArrived('run:run_test', 'worker_done')
    await Promise.resolve()
    await Promise.resolve()

    expect(tabMountSends).toHaveLength(1)
    expect(tabMountSends[0]?.[1]).toMatchObject({ tabId: TAB_ID })
    db.close()
  })

  it('delivers the queued run mail once the woken pane is back and idle', async () => {
    const { runtime, db, handle, tabMountSends, write, remountWithPty } =
      await sleptPaneRuntime(sleepingRecord())
    db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'run:run_test',
      subject: 'worker done',
      type: 'worker_done'
    })
    runtime.notifyMessageArrived('run:run_test', 'worker_done')
    await Promise.resolve()
    await Promise.resolve()
    expect(tabMountSends).toHaveLength(1)

    // The wake is only half the promise: the mail must actually reach the agent.
    remountWithPty('pty-woken')
    await Promise.resolve()

    expect(write).toHaveBeenCalledWith(
      'pty-woken',
      expect.stringContaining('You have 1 orchestration message')
    )
    expect(message.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it.each([
    {
      caseName: 'after graph publication with fresh local foreground confirmation',
      foregroundProcess: 'zsh',
      confirmedForegroundProcess:
        '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex',
      foregroundConfirmationSupported: true,
      graphBeforeRegistration: true
    },
    {
      caseName: 'before graph publication through an SSH provider without foreground confirmation',
      foregroundProcess: 'codex',
      confirmedForegroundProcess: null,
      foregroundConfirmationSupported: false,
      graphBeforeRegistration: false
    }
  ])(
    'delivers after a statusless Codex reattach clears its working spinner $caseName',
    async ({
      foregroundProcess,
      confirmedForegroundProcess,
      foregroundConfirmationSupported,
      graphBeforeRegistration
    }) => {
      vi.useFakeTimers()
      try {
        const {
          runtime,
          db,
          handle,
          write,
          remountStatuslessCodex,
          setForegroundProcess,
          setConfirmedForegroundProcess,
          setForegroundConfirmationSupported
        } = await sleptPaneRuntime(sleepingRecord({ agent: 'codex' }))
        db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
        const message = db.insertMessage({
          from: 'term_worker',
          to: 'run:run_test',
          subject: 'worker done',
          type: 'worker_done'
        })
        runtime.notifyMessageArrived('run:run_test', 'worker_done')
        await Promise.resolve()
        await Promise.resolve()

        const reattachDelivery = vi.spyOn(runtime, 'deliverPendingMessagesForHandle')
        const highLevelPrompt = vi
          .spyOn(runtime, 'sendTerminalAgentPrompt')
          .mockRejectedValue(new Error('statusless Codex has no hook tui-idle edge'))
        const settledPromptReadiness = vi
          .spyOn(runtime, 'isTerminalRunningSettledPromptAgent')
          .mockResolvedValue(false)
        setForegroundProcess(foregroundProcess)
        setConfirmedForegroundProcess(confirmedForegroundProcess)
        setForegroundConfirmationSupported(foregroundConfirmationSupported)
        write.mockImplementation((ptyId: string, data: string) => {
          if (data.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)) {
            // The resumed TUI can emit a live but unclassified title after the
            // original statusless-idle proof and before the submit write.
            runtime.onPtyData(ptyId, '\x1b]0;workspace\x07\x1b[?25h', 101)
          } else if (data === '\r') {
            runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 102)
          }
          return true
        })
        remountStatuslessCodex('pty-codex-woken', graphBeforeRegistration)
        expect(reattachDelivery).toHaveBeenCalledWith(handle)
        const runtimeState = runtime as unknown as {
          leaves: Map<
            string,
            { leafId: string; lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
          >
          ptysById: Map<
            string,
            { lastAgentStatus: string | null; lastAgentStatusObservedLive: boolean }
          >
        }
        expect(
          [...runtimeState.leaves.values()].find((leaf) => leaf.leafId === LEAF_ID)
        ).toMatchObject({
          lastAgentStatus: null,
          lastAgentStatusObservedLive: true
        })
        expect(runtimeState.ptysById.get('pty-codex-woken')).toMatchObject({
          lastAgentStatus: null,
          lastAgentStatusObservedLive: true
        })
        await vi.advanceTimersByTimeAsync(12_000)
        await vi.waitFor(() =>
          expect(write).toHaveBeenCalledWith(
            'pty-codex-woken',
            expect.stringContaining(
              `${AGENT_PROMPT_BRACKETED_PASTE_START}\nYou have 1 orchestration message`
            )
          )
        )

        expect(write).toHaveBeenCalledWith('pty-codex-woken', '\r')
        expect(highLevelPrompt).not.toHaveBeenCalled()
        expect(settledPromptReadiness).not.toHaveBeenCalled()
        expect(message.delivered_at).toEqual(expect.any(String))
        db.close()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('does not submit a statusless Codex pointer after the child exits to a shell', async () => {
    vi.useFakeTimers()
    try {
      const {
        runtime,
        db,
        handle,
        write,
        remountStatuslessCodex,
        setForegroundProcess,
        setConfirmedForegroundProcess
      } = await sleptPaneRuntime(sleepingRecord({ agent: 'codex' }))
      db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
      const message = db.insertMessage({
        from: 'term_worker',
        to: 'run:run_test',
        subject: 'worker done',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived('run:run_test', 'worker_done')
      await Promise.resolve()
      await Promise.resolve()

      setForegroundProcess('codex')
      setConfirmedForegroundProcess('codex')
      write.mockImplementation((ptyId: string, data: string) => {
        if (data.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)) {
          setConfirmedForegroundProcess('zsh')
          runtime.onPtyData(ptyId, '\x1b]0;workspace\x07\x1b[?25h', 101)
        }
        return true
      })
      remountStatuslessCodex('pty-codex-woken', true)
      await vi.advanceTimersByTimeAsync(12_000)

      expect(write).toHaveBeenCalledWith(
        'pty-codex-woken',
        expect.stringContaining(
          `${AGENT_PROMPT_BRACKETED_PASTE_START}\nYou have 1 orchestration message`
        )
      )
      expect(write).not.toHaveBeenCalledWith('pty-codex-woken', '\r')
      expect(message.delivered_at).toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries after a resumed Codex takes foreground just after its restored screen appears', async () => {
    vi.useFakeTimers()
    try {
      const {
        runtime,
        db,
        handle,
        write,
        confirmForegroundProcess,
        remountStatuslessCodex,
        setForegroundProcess
      } = await sleptPaneRuntime(sleepingRecord({ agent: 'codex' }))
      db.setRun({ id: 'run_test', coordinator_handle: handle, coordinator_pane_key: PANE_KEY })
      const message = db.insertMessage({
        from: 'term_worker',
        to: 'run:run_test',
        subject: 'worker done',
        type: 'worker_done'
      })
      runtime.notifyMessageArrived('run:run_test', 'worker_done')
      await Promise.resolve()
      await Promise.resolve()

      const firstForegroundConfirmation = deferred<string | null>()
      confirmForegroundProcess
        .mockImplementationOnce(() => firstForegroundConfirmation.promise)
        .mockResolvedValue('codex')
      setForegroundProcess('codex')
      write.mockImplementation((ptyId: string, data: string) => {
        if (data === '\r') {
          runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 102)
        }
        return true
      })
      remountStatuslessCodex('pty-codex-woken', true)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledTimes(1))
      runtime.onPtyData('pty-codex-woken', 'restored output\n', 101)
      firstForegroundConfirmation.resolve('zsh')
      await flushMicrotasks()
      expect(write).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(12_000)
      expect(confirmForegroundProcess).toHaveBeenCalledTimes(3)
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith(
          'pty-codex-woken',
          expect.stringContaining(
            `${AGENT_PROMPT_BRACKETED_PASTE_START}\nYou have 1 orchestration message`
          )
        )
      )

      expect(write).toHaveBeenCalledWith('pty-codex-woken', '\r')
      expect(message.delivered_at).toEqual(expect.any(String))
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
