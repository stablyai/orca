import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: execFileMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { registerPty, unregisterPty } from '../memory/pty-registry'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`
// Past every foreground read the renderer's pane tracker schedules after a command start.
const AFTER_FOREGROUND_READS_MS = 350 + 1200 + 6000
const SHELL_PID = 100

// The host's process table: the pane's shell running `opencode run` in the foreground.
function mockProcessTable(): void {
  const rows = [
    `${SHELL_PID} 99 100 101 Ss /bin/zsh -l`,
    `101 ${SHELL_PID} 101 101 S+ /opt/homebrew/bin/opencode run fix the bug`
  ]
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void
    ) => callback(null, { stdout: rows.join('\n'), stderr: '' })
  )
}

function createRuntime(): {
  runtime: OrcaRuntimeService
  wiring: ReturnType<typeof makeAgentStatusStoreWiring>
  statuses: RuntimeTerminalAgentStatusEvent[]
  facts: string[]
} {
  const wiring = makeAgentStatusStoreWiring()
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const facts: string[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    ...wiring.deps,
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      wiring.deps.onTerminalAgentStatus(event)
    },
    onTerminalSideEffects: (batch) => facts.push(...batch.facts.map((fact) => fact.kind))
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
  return { runtime, wiring, statuses, facts }
}

// Why: status comes only from an agent's own hooks or plugins. OpenCode 2's `opencode run` loads
// none, so its pane shows no row, even while the pane's foreground is OpenCode.
describe('`opencode run` in a pane', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    resetProcessTableSnapshotForTests()
    mockProcessTable()
    registerPty({
      ptyId: 'pty-1',
      worktreeId: WORKTREE_ID,
      sessionId: null,
      paneKey: PANE_KEY,
      pid: SHELL_PID
    })
  })

  afterEach(() => {
    unregisterPty('pty-1')
    execFileMock.mockReset()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    vi.useRealTimers()
  })

  it('posts no status while it runs or when its command finishes', async () => {
    const { runtime, wiring, statuses, facts } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(AFTER_FOREGROUND_READS_MS)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)

    expect(facts).toContain('command-finished')
    expect(statuses).toEqual([])
    expect(wiring.statusStore.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
  })

  it('posts no status when the daemon reports the command finished while hidden', async () => {
    const { runtime, wiring, statuses, facts } = createRuntime()

    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(AFTER_FOREGROUND_READS_MS)
    runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'command-finished', exitCode: 130 })

    expect(facts).toContain('command-finished')
    expect(statuses).toEqual([])
    expect(wiring.statusStore.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
  })
})
