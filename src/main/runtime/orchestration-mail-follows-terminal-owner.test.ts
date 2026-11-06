import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import {
  createRuntime,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  SECOND_LEAF_ID,
  SECOND_TAB_ID,
  TAB_ID,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

const RENDERER_PTY_ID = 'pty-renderer'
const GRAPH = {
  tabs: [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: 'Codex', activeLeafId: LEAF_ID, layout: null }
  ],
  leaves: [
    {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      worktreeId: WORKTREE_ID,
      paneRuntimeId: 1,
      ptyId: RENDERER_PTY_ID
    }
  ]
}

describe('Run mail follows the terminal that owns its mailbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not type a stale pointer after the terminal moves to another pane mid-probe', async () => {
    const db = new OrchestrationDb(':memory:')
    const { runtime } = createRuntime(db)
    const write = vi.fn(() => true)
    let finishProbe: ((live: boolean) => void) | undefined
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null,
      probePtyLiveness: () => new Promise<boolean>((resolve) => (finishProbe = resolve))
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const run = db.createRun({
      objective: 'Moved coordinator',
      coordinatorHandle: terminal.handle,
      coordinatorPaneKey: PANE_KEY
    })
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    db.insertMessage({
      from: 'term_sender',
      to: `run:${run.id}`,
      subject: 'old pane',
      type: 'status',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(0)
    expect(finishProbe).toBeTypeOf('function')

    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: SECOND_TAB_ID,
      leafId: SECOND_LEAF_ID,
      incarnationId: 'mailbox-incarnation'
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: SECOND_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Moved',
          activeLeafId: SECOND_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: SECOND_TAB_ID,
          leafId: SECOND_LEAF_ID,
          worktreeId: WORKTREE_ID,
          ptyId: PTY_ID,
          paneRuntimeId: 2
        }
      ]
    })
    finishProbe?.(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('wakes a Run bound to one of two panes showing its terminal, whichever is listed first', async () => {
    const runtime = new OrcaRuntimeService(null)
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(RENDERER_PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'original'
    })
    // A launched agent's handle outlives aliases; a pane-issued one is dropped once two panes show it.
    runtime.registerPreAllocatedHandleForPty(RENDERER_PTY_ID, 'term_preallocated')
    const paneA = GRAPH.leaves[0]!
    const aliasB = { ...paneA, tabId: SECOND_TAB_ID, leafId: SECOND_LEAF_ID, paneRuntimeId: 2 }
    const showing = (leaves: (typeof paneA)[]) => ({
      tabs: [
        ...GRAPH.tabs,
        { ...GRAPH.tabs[0]!, tabId: SECOND_TAB_ID, activeLeafId: SECOND_LEAF_ID }
      ],
      leaves
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, showing([aliasB, paneA]))
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Coordinator in pane A',
      coordinatorHandle: 'term_preallocated',
      coordinatorPaneKey: PANE_KEY
    })
    runtime.onPtyData(RENDERER_PTY_ID, '\x1b]0;Codex done\x07', 1)
    await runtime.serializeMainTerminalBuffer(RENDERER_PTY_ID)
    const message = db.insertMessage({
      from: 'term_sender',
      to: `run:${run.id}`,
      subject: 'worker done',
      type: 'worker_done',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)

    // The alias unmounts and remounts ahead of A before the delayed Enter rechecks ownership.
    runtime.syncWindowGraph(1, showing([paneA]))
    runtime.syncWindowGraph(1, showing([aliasB, paneA]))
    await vi.advanceTimersByTimeAsync(600)
    expect(write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
    expect(pointerCount(write)).toBe(1)
    db.close()
  })
})

// Reload start keeps a terminal's waits and identity; a failed graph still ends them, as before.
describe.each(['pane-issued', 'preallocated'] as const)('a %s handle across a reload', (origin) => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function rendererTerminal() {
    const runtime = new OrcaRuntimeService(null)
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(RENDERER_PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'original'
    })
    if (origin === 'preallocated') {
      runtime.registerPreAllocatedHandleForPty(RENDERER_PTY_ID, 'term_preallocated')
    }
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, GRAPH)
    const [terminal] = (await runtime.listTerminals()).terminals
    return { runtime, write, handle: terminal.handle }
  }

  it.each(['reload-failed', 'window-unavailable'] as const)(
    'keeps a wait at reload start and rejects it when %s',
    async (failure) => {
      const { runtime, handle } = await rendererTerminal()
      let outcome: unknown = null
      void runtime.waitForTerminal(handle, { condition: 'exit' }).then(
        (result) => (outcome = result),
        (error: Error) => (outcome = error.message)
      )
      runtime.markRendererReloading(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toBeNull()

      if (failure === 'reload-failed') {
        runtime.markGraphReloadFailed(1, 'renderer-process-gone')
      } else {
        runtime.markGraphUnavailable(1)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toBe('terminal_handle_stale')
    }
  )

  it('keeps a wait through a successful reload until the terminal exits', async () => {
    const { runtime, handle } = await rendererTerminal()
    let outcome: unknown = null
    const wait = runtime.waitForTerminal(handle, { condition: 'exit' }).then(
      (result) => (outcome = result),
      (error: Error) => (outcome = error.message)
    )
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, GRAPH)
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBeNull()

    runtime.onPtyExit(RENDERER_PTY_ID, 0)
    await wait
    expect(outcome).toMatchObject({ handle, condition: 'exit', satisfied: true })
  })

  it('keeps a tui-idle wait while its pane remounts, then settles it on idle', async () => {
    const { runtime, handle } = await rendererTerminal()
    runtime.onPtyData(RENDERER_PTY_ID, '\x1b]0;Codex working\x07', 1)
    let outcome: unknown = null
    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 }).then(
      (result) => (outcome = result),
      (error: Error) => (outcome = error.message)
    )
    // Opening a workspace remounts the pane, which briefly publishes no terminal.
    runtime.syncWindowGraph(1, { ...GRAPH, leaves: [{ ...GRAPH.leaves[0]!, ptyId: null }] })
    runtime.syncWindowGraph(1, GRAPH)
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBeNull()

    runtime.onPtyData(RENDERER_PTY_ID, '\x1b]0;Codex done\x07', 2)
    await vi.advanceTimersByTimeAsync(5_000)
    await wait
    expect(outcome).toMatchObject({ handle, condition: 'tui-idle', satisfied: true })
  })

  it('points Run mail at the terminal and submits it while the renderer reloads', async () => {
    const { runtime, write, handle } = await rendererTerminal()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Reloading coordinator',
      coordinatorHandle: handle,
      coordinatorPaneKey: PANE_KEY
    })
    runtime.onPtyData(RENDERER_PTY_ID, '\x1b]0;Codex done\x07', 1)
    await runtime.serializeMainTerminalBuffer(RENDERER_PTY_ID)
    runtime.markRendererReloading(1)
    const message = db.insertMessage({
      from: 'term_sender',
      to: `run:${run.id}`,
      subject: 'new mail',
      type: 'status',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, pointer_enter_pending: 2 })

    await vi.advanceTimersByTimeAsync(600)
    expect(write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(0)
    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
    expect(pointerCount(write)).toBe(1)
    db.close()
  })
})
