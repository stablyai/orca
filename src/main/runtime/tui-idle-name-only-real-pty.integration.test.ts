import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import { getForegroundProcessName } from '../../relay/pty-shell-utils'

// #6011 end-to-end: a REAL pty running a REAL process that emits a REAL name-only
// OSC title while streaming must not satisfy `orca terminal wait --for tui-idle`.
// Everything below is live — real bytes, real `ps` foreground reads, real timers —
// because the bug was a wait that returned satisfied in ~0s, so timing IS the proof.

const FIXTURE = fileURLToPath(new URL('./tui-idle-agent-fixture.mjs', import.meta.url))
const WORKTREE_ID = 'repo-1::/tmp/tui-idle-real-pty'
const TAB_ID = '55555555-5555-4555-8555-555555555555'
const LEAF_ID = '66666666-6666-4666-8666-666666666666'
const PTY_ID = 'pty-tui-idle-real'

const waitMethod = TERMINAL_LIFECYCLE_METHODS.find((method) => method.name === 'terminal.wait')!

const running: pty.IPty[] = []

afterEach(() => {
  while (running.length > 0) {
    try {
      running.pop()?.kill()
    } catch {
      // The fixture may already be gone.
    }
  }
})

async function startRealAgentPane(mode: 'explicit-idle' | 'quiet', workMs: number) {
  const child = pty.spawn(process.execPath, [FIXTURE, mode, String(workMs)], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: '/tmp'
  })
  running.push(child)

  // Real foreground read against the real pty: the same helper the relay serves
  // `pty.getForegroundProcess` with, so corroboration is host-produced here too.
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/tui-idle-real-pty',
    getForegroundProcess: () => getForegroundProcessName(child.pid, child.process || null)
  })
  runtime.attachWindow(1)
  const graph: RuntimeSyncWindowGraph = {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Agent',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  }
  runtime.syncWindowGraph(1, graph)

  const transcript: string[] = []
  child.onData((data) => {
    transcript.push(data)
    runtime.onPtyData(PTY_ID, data, Date.now())
  })

  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, transcript, handle: terminals[0].handle }
}

/** Exactly what `orca terminal wait --terminal <h> --for tui-idle` reaches over RPC. */
async function terminalWait(
  runtime: OrcaRuntimeService,
  terminal: string,
  timeoutMs: number
): Promise<{ satisfied: boolean; elapsedMs: number }> {
  const startedAt = Date.now()
  try {
    const result = await waitMethod.handler(
      { terminal, for: 'tui-idle', timeoutMs },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.wait reads only `runtime` off its context; the rest is request plumbing this fixture has no use for.
      { runtime } as Parameters<typeof waitMethod.handler>[1]
    )
    return { satisfied: result.wait.satisfied === true, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    // Why only `timeout`: an unsatisfied wait is the outcome under test, but any other
    // failure means the harness broke and must not read as a passing refusal.
    if ((error instanceof Error ? error.message : String(error)) !== 'timeout') {
      throw error
    }
    return { satisfied: false, elapsedMs: Date.now() - startedAt }
  }
}

describe.skipIf(process.platform === 'win32')('tui-idle against a real agent pty', () => {
  it('does not satisfy while the real process streams under a name-only title', async () => {
    const { runtime, transcript, handle } = await startRealAgentPane('quiet', 60_000)
    await new Promise((resolve) => setTimeout(resolve, 500))

    // The OSC title really did reach the runtime as control bytes, not literal text.
    expect(transcript.join('')).toContain(']0;Codex')

    const outcome = await terminalWait(runtime, handle, 8_000)
    expect(outcome.satisfied).toBe(false)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(7_500)
  }, 25_000)

  it('satisfies once the real process emits an explicit idle title', async () => {
    const { runtime, handle } = await startRealAgentPane('explicit-idle', 3_000)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const outcome = await terminalWait(runtime, handle, 20_000)
    expect(outcome.satisfied).toBe(true)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1_500)
  }, 28_000)

  it('satisfies once the real process goes quiet with the agent still in foreground', async () => {
    const { runtime, handle } = await startRealAgentPane('quiet', 3_000)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const outcome = await terminalWait(runtime, handle, 20_000)
    expect(outcome.satisfied).toBe(true)
    // Corroboration is never instant: quiescence must elapse after the last byte.
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(3_000)
  }, 28_000)
})
