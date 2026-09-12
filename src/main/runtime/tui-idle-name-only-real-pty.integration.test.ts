import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import { getForegroundProcessName } from '../../relay/pty-shell-utils'
import { getDefaultWorkspaceSession } from '../../shared/constants'

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

function makeStore() {
  return {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    getRepos: () => [
      {
        id: 'repo-1',
        path: '/tmp/tui-idle-real-pty',
        displayName: 'tui-idle-real-pty',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => {},
    removeWorktreeMeta: () => {},
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => []
  }
}

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

  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: async () => ({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    // Real foreground read against the real pty: the same helper the relay serves
    // `pty.getForegroundProcess` with, so corroboration is host-produced here too.
    getForegroundProcess: () => getForegroundProcessName(child.pid, child.process || null),
    listProcesses: async () => [],
    hasPty: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
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
  })

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
      { terminal, for: 'tui-idle', timeoutMs } as never,
      {
        runtime
      } as never
    )
    return { satisfied: result.wait.satisfied === true, elapsedMs: Date.now() - startedAt }
  } catch {
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
