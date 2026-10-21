import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readCommandLineMock } = vi.hoisted(() => ({ readCommandLineMock: vi.fn() }))

vi.mock('./local-pty-foreground-command-line', () => ({
  readLocalPtyForegroundCommandLine: readCommandLineMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function createRuntime(): {
  runtime: OrcaRuntimeService
  statuses: RuntimeTerminalAgentStatusEvent[]
  channelOrder: string[]
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const channelOrder: string[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      channelOrder.push(`status:${event.payload.state}`)
    },
    onTerminalSideEffects: (batch) =>
      channelOrder.push(...batch.facts.map((fact) => `fact:${fact.kind}`))
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'opencode'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-1', worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: 'pty-1' }
    ]
  })
  return { runtime, statuses, channelOrder }
}

const summary = (statuses: RuntimeTerminalAgentStatusEvent[]): string[] =>
  statuses.map(
    (event) =>
      `${event.paneKey}:${event.payload.state}${event.payload.interrupted ? ':interrupted' : ''}:${event.origin}`
  )

// `opencode run` typed in a pane: the pane's own command boundaries and foreground drive its row.
describe('OpenCode run process lifetime in the runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readCommandLineMock.mockReset()
    readCommandLineMock.mockResolvedValue('opencode run fix the bug')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts Working after the command starts and Done when it finishes, on its own pane', async () => {
    const { runtime, statuses } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    expect(readCommandLineMock).toHaveBeenCalledWith('pty-1', 'opencode')
    expect(statuses[0]?.yieldsToHookSince).toBe(statuses[1]?.yieldsToHookSince)
  })

  // Why: the renderer drops an exited agent's row on command-finished unless it changed after.
  it("publishes the run's Done after the command-finished fact of the same chunk", async () => {
    const { runtime, channelOrder } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(channelOrder).toEqual(['status:working', 'fact:command-finished', 'status:done'])
  })

  it('posts Done from the daemon fact when the pane finished while hidden', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 130 })

    expect(channelOrder.slice(-2)).toEqual(['fact:command-finished', 'status:done'])
    expect(summary(statuses)).toEqual([
      `${PANE_KEY}:working:process`,
      `${PANE_KEY}:done:interrupted:process`
    ])
  })

  it('stays silent for an SSH pane', async () => {
    const { runtime, statuses } = createRuntime()
    runtime.registerPty('pty-1', WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
    runtime.onPtyData('pty-1', '\x1b]133;D;0\x07', 101)

    expect(statuses).toEqual([])
    expect(readCommandLineMock).not.toHaveBeenCalled()
  })

  it('reports a local Windows pane from its own foreground', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const { runtime, statuses } = createRuntime()
      readCommandLineMock.mockResolvedValue('"C:\\Tools\\opencode.exe" run fix it')

      runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
      runtime.onPtyData('pty-1', '\x1b]133;D;0\x07', 101)

      expect(summary(statuses)).toEqual([`${PANE_KEY}:working:process`, `${PANE_KEY}:done:process`])
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
