import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { postHookEvent } from '../agent-hooks/server.test-fixtures'
import { BackgroundTransientFactRelay } from '../daemon/daemon-background-transient-facts'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { spawnedPtyEnv } from './spawned-pty-env-fixtures'
import { committingSpawn } from './bind-first-pane.test-fixture'

const PTY_ID = 'pty-omp-handoff'
const WORKTREE_PATH = '/tmp/worktree-omp'
const SESSION_ID = 'omp-session-handoff'

vi.mock('../git/worktree', () => {
  const worktrees = [
    { path: '/tmp/worktree-omp', head: 'abc', branch: 'omp', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OMP hook authority across transient scanner handoffs', () => {
  const cleanup: (() => void)[] = []

  afterEach(() => {
    for (const dispose of cleanup.splice(0).toReversed()) {
      dispose()
    }
    vi.restoreAllMocks()
  })

  async function launchPane() {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    cleanup.push(() => server.stop())
    const spawn = vi.fn(
      async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
        id: PTY_ID,
        incarnationId: 'incarnation-1'
      })
    )
    const retire = vi.fn((paneKey: string) => server.retirePaneAuthority(paneKey))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore supplies the repo reads used by terminal creation.
    const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate),
      retireAgentHookCompatibilityAuthority: retire
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'omp'
    })
    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      command: 'omp',
      launchConfig: { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
      launchAgent: 'omp'
    })
    const env = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
    const paneKey = env.ORCA_PANE_KEY!
    const launchToken = env.ORCA_AGENT_LAUNCH_TOKEN!
    expect(paneKey).toBeTruthy()
    expect(launchToken).toBeTruthy()
    const evidence = { terminalHandle: terminal.handle, paneKey, launchToken }
    const attest = () =>
      server.attestCompatibilityAuthority({
        paneKey,
        launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    const post = async (hookEvent: string, prompt?: string) => {
      const response = await postHookEvent(
        server,
        {
          paneKey,
          launchToken,
          tabId: paneKey.split(':')[0],
          worktreeId: `path:${WORKTREE_PATH}`,
          env: 'production',
          payload: { hook_event_name: hookEvent, session_id: SESSION_ID, prompt }
        },
        '/hook/omp'
      )
      expect(response.status).toBe(204)
    }
    await post('before_agent_start', 'first turn')
    expect(attest()).not.toBeNull()
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    const acceptedRows = server.getStatusSnapshotForPane(paneKey)
    expect(acceptedRows).toEqual([
      expect.objectContaining({
        paneKey,
        launchToken,
        state: 'working',
        agentType: 'omp',
        providerSession: { key: 'session_id', id: SESSION_ID }
      })
    ])
    const relay = new BackgroundTransientFactRelay((sessionId, fact) => {
      expect(sessionId).toBe(PTY_ID)
      runtime.emitDaemonPtyTransientFact(sessionId, fact)
    })
    cleanup.push(() => relay.dispose())
    cleanup.push(() => runtime.onPtyExit(PTY_ID, 0))
    let at = 100
    const feed = (data: string) => {
      relay.onSessionData(PTY_ID, data)
      runtime.onPtyData(PTY_ID, data, at++)
    }
    const background = (delegated: boolean) => {
      const state = relay.getOsc133ScanState(PTY_ID)
      expect(relay.setSessionBackground(PTY_ID, delegated)).toBe(true)
      runtime.setPtyTransientFactDelegation(PTY_ID, delegated, undefined, undefined, state)
    }
    const expectRetainedAndAcceptNextTurn = async () => {
      expect(retire).not.toHaveBeenCalled()
      expect(server.getStatusSnapshotForPane(paneKey)).toEqual(acceptedRows)
      expect(attest()).not.toBeNull()
      expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
      await post('agent_end')
      expect(server.getStatusSnapshotForPane(paneKey)).toEqual([
        expect.objectContaining({
          state: 'done',
          providerSession: { key: 'session_id', id: SESSION_ID }
        })
      ])
      await post('before_agent_start', 'next accepted turn')
      expect(server.getStatusSnapshotForPane(paneKey)).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'next accepted turn',
          providerSession: { key: 'session_id', id: SESSION_ID }
        })
      ])
    }
    const expectRetired = () => {
      expect(retire).toHaveBeenCalledExactlyOnceWith(paneKey)
      expect(attest()).toBeNull()
      expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
      expect(server.getStatusSnapshotForPane(paneKey)).toEqual([])
    }
    return { feed, background, expectRetainedAndAcceptNextTurn, expectRetired }
  }

  for (const [terminatorName, terminator] of [
    ['BEL', '\x07'],
    ['ST', '\x1b\\']
  ] as const) {
    const b = `\x1b]133;B${terminator}`
    const c = `\x1b]133;C${terminator}`
    const d = `\x1b]133;D;0${terminator}`
    const bubble = b + c + d
    for (const [boundary, offset] of [
      ['after B', b.length],
      ['after BC', b.length + c.length],
      ['inside D', b.length + c.length + '\x1b]133;D;'.length]
    ] as const) {
      for (const direction of ['foreground to background', 'background to foreground'] as const) {
        it(`retains accepted hooks ${direction} ${boundary} (${terminatorName})`, async () => {
          const pane = await launchPane()
          if (direction === 'background to foreground') {
            pane.background(true)
          }
          pane.feed(bubble.slice(0, offset))
          pane.background(direction === 'foreground to background')
          for (const character of bubble.slice(offset)) {
            pane.feed(character)
          }
          await pane.expectRetainedAndAcceptNextTurn()
          pane.feed(`${c}real shell output${d}\x1b]133;A${terminator}$ `)
          pane.expectRetired()
        })
      }
    }
  }

  for (const delegated of [false, true]) {
    it(`still retires a failed app command after handoff to ${delegated ? 'background' : 'foreground'}`, async () => {
      const pane = await launchPane()
      if (!delegated) {
        pane.background(true)
      }
      pane.feed('\x1b]133;B\x07\x1b]133;C\x07')
      pane.background(delegated)
      pane.feed('\x1b]133;D;1\x07')
      pane.expectRetired()
    })
  }
})
