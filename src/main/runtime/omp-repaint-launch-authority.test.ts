import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// #24436: a resident OMP TUI repaints its transcript (resize, split, sidebar switches) and
// re-emits the rendered user message's OSC 133;A..D marks mid-turn. Those marks must not
// retire the pane's launch authority, or the closed-pane gate 204-suppresses every later
// mid-turn hook (tool_execution_start/end, message_end, agent_end) and the status row stays
// gone until the next prompt. A genuinely finished turn (done row) and a real PTY exit must
// still retire, matching the STA-4557 semantics pinned in opencode-finished-session-authority.

const WORKTREE_PATH = '/tmp/worktree-omp-repaint'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-omp-repaint',
      head: 'abc',
      branch: 'feature/omp-repaint',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-omp-repaint',
      head: 'abc',
      branch: 'feature/omp-repaint',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

type LaunchedOmpPane = {
  runtime: OrcaRuntimeService
  server: AgentHookServer
  ptyId: string
  paneKey: string
  tabId: string
  launchToken: string
  incarnationId: string
}

async function launchOmpPane(ptyId: string): Promise<LaunchedOmpPane> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  const incarnationId = 'omp-incarnation-1'
  const spawn = vi.fn().mockResolvedValue({ id: ptyId, incarnationId })
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      server.attestCompatibilityAuthority(candidate),
    getAgentStatusSnapshot: () =>
      server.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true)
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'omp'
  })
  await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    command: 'omp',
    launchConfig: { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
    launchAgent: 'omp'
  })
  const env = (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
  const paneKey = env.ORCA_PANE_KEY as string
  const launchToken = env.ORCA_AGENT_LAUNCH_TOKEN as string
  expect(paneKey).toBeTruthy()
  expect(launchToken).toBeTruthy()
  return {
    runtime,
    server,
    ptyId,
    paneKey,
    tabId: paneKey.split(':')[0]!,
    launchToken,
    incarnationId
  }
}

describe('OMP repaint launch authority (#24436)', () => {
  let pane: LaunchedOmpPane

  afterEach(() => {
    pane?.server.stop()
  })

  async function postOmpHook(payload: Record<string, unknown>): Promise<void> {
    const hookEnv = pane.server.buildPtyEnv()
    const res = await fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/omp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': hookEnv.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: pane.paneKey,
        launchToken: pane.launchToken,
        tabId: pane.tabId,
        worktreeId: 'wt-omp-repaint',
        env: 'production',
        payload
      })
    })
    expect(res.status).toBe(204)
  }

  const attestCurrent = (): unknown =>
    pane.server.attestCompatibilityAuthority({
      paneKey: pane.paneKey,
      launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
      connectionId: null,
      terminalProvenance: 'current_runtime'
    })

  const snapshotState = (): string | undefined =>
    pane.server.getStatusSnapshot().find((entry) => entry.paneKey === pane.paneKey)?.state

  it('keeps launch authority and the working row when OMP repaints mid-turn', async () => {
    pane = await launchOmpPane('pty-omp-repaint')
    await postOmpHook({ hook_event_name: 'before_agent_start', sessionID: 's-1' })
    await postOmpHook({ hook_event_name: 'tool_execution_start', tool_name: 'bash' })
    expect(snapshotState()).toBe('working')
    expect(attestCurrent()).not.toBeNull()

    // OMP repaints its transcript (SIGWINCH from a split/resize) and re-emits the user
    // message's OSC 133;D;0 while the turn is still running.
    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)

    expect(attestCurrent()).not.toBeNull()
    expect(snapshotState()).toBe('working')

    // The turn's later hooks must still be applied, not suppressed by a closed-pane gate.
    await postOmpHook({ hook_event_name: 'message_end' })
    expect(snapshotState()).toBe('working')
    await postOmpHook({ hook_event_name: 'agent_end' })
    expect(snapshotState()).toBe('done')
  })

  it('keeps launch authority when the repaint arrives as a daemon transient fact', async () => {
    pane = await launchOmpPane('pty-omp-repaint-daemon')
    await postOmpHook({ hook_event_name: 'before_agent_start', sessionID: 's-1' })
    expect(attestCurrent()).not.toBeNull()

    pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(attestCurrent()).not.toBeNull()
    expect(snapshotState()).toBe('working')
  })

  it('still retires launch authority once the OMP turn has ended', async () => {
    pane = await launchOmpPane('pty-omp-turn-end')
    await postOmpHook({ hook_event_name: 'before_agent_start', sessionID: 's-1' })
    await postOmpHook({ hook_event_name: 'agent_end' })
    expect(snapshotState()).toBe('done')

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)

    expect(attestCurrent()).toBeNull()
  })

  it('still retires launch authority through the real PTY exit while a turn row is fresh', async () => {
    pane = await launchOmpPane('pty-omp-real-exit')
    await postOmpHook({ hook_event_name: 'before_agent_start', sessionID: 's-1' })
    expect(snapshotState()).toBe('working')

    await pane.runtime.onPtyExit(pane.ptyId, 0, pane.incarnationId)

    expect(attestCurrent()).toBeNull()
    expect(snapshotState()).toBeUndefined()
  })
})
