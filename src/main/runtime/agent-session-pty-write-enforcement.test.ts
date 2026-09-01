import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../shared/terminal-input'
import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

// The runtime send paths are the choke point every RPC, plugin, and orchestration write funnels
// through, so each one is proved to consult the lease and to leave unbound PTYs untouched.

const WORKTREE_ID = 'repo-1::/tmp/lease-worktree'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = 'run-1'
const PTY_ID = 'pty-agent-session'
const SESSION_ID = 'session-alpha-1'

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/lease-worktree',
        displayName: 'lease',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

const records = new Map<string, AgentSessionRecord>()

function publish(lease: AgentSessionLease): void {
  records.set(lease.sessionId, agentSessionRecordFixture(lease))
}

async function makeRuntime(options: { onWrite?: (ptyId: string, data: string) => void } = {}) {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const write = vi.fn((ptyId: string, data: string) => {
    options.onWrite?.(ptyId, data)
    // A real agent starts working when it receives the submit, and the prompt path now waits for
    // that transition before it reports success. Without it every happy path here reads as stalled.
    if (data === AGENT_PROMPT_SUBMIT) {
      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
    }
    return true
  })
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    hasPty: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Agent',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle, write }
}

function enforce(lease: AgentSessionLease = agentSessionLeaseFixture()): void {
  publish(lease)
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
  agentSessionPtyWriteGate.bindPty(PTY_ID, SESSION_ID)
}

afterEach(() => {
  agentSessionPtyWriteGate.detachRecordLookup()
  records.clear()
})

describe('exemption: nothing that exists today is enforced', () => {
  it('sends normally when no session record is bound to the pty', async () => {
    const { runtime, handle, write } = await makeRuntime()

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(PTY_ID, 'ls')
  })

  it('sends normally when the store is attached but this pty is a legacy agent terminal', async () => {
    const { runtime, handle, write } = await makeRuntime()
    publish(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
    agentSessionPtyWriteGate.bindPty('some-other-pty', SESSION_ID)

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(PTY_ID, 'ls')
  })

  it('sends agent prompts normally on an unbound pty', async () => {
    const { runtime, handle, write } = await makeRuntime()

    await expect(runtime.sendTerminalAgentPrompt(handle, 'go')).resolves.toBeDefined()

    expect(write).toHaveBeenCalled()
  })
})

describe('terminal.send path', () => {
  it('writes when the TUI owner holds a proven-live lease', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce()

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(PTY_ID, 'ls')
  })

  it('refuses and writes nothing when native chat owns the session', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).rejects.toThrow(
      'agent_session_conflict'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('refuses while a handoff is in flight', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ handoffStage: 'new-owner-proving' }))

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).rejects.toThrow(
      'agent_session_conflict'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('refuses while the lease is unreconciled after a host restart', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ unreconciled: true }))

    await expect(runtime.sendTerminal(handle, { text: 'ls' })).rejects.toThrow(
      'execution_owner_reconciling'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('refuses an interrupt, which carries no text of its own', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))

    await expect(runtime.sendTerminal(handle, { interrupt: true })).rejects.toThrow(
      'agent_session_conflict'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('refuses before the mobile floor is reserved', async () => {
    const { runtime, handle } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))
    const reserveWrite = vi.fn()

    await expect(runtime.sendTerminal(handle, { text: 'ls' }, { reserveWrite })).rejects.toThrow()

    expect(reserveWrite).not.toHaveBeenCalled()
  })

  it('refuses when an async send guard outlives the admitted fence', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))

    await expect(
      runtime.sendTerminal(
        handle,
        { text: 'ls' },
        {
          beforeWrite: async () => {
            publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
            await Promise.resolve()
          }
        }
      )
    ).rejects.toThrow('agent_session_checkpoint_stale')

    expect(write).not.toHaveBeenCalled()
  })
})

describe('agent prompt path', () => {
  it('refuses the whole paste when another runtime owns the session', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))

    await expect(runtime.sendTerminalAgentPrompt(handle, 'do the thing')).rejects.toThrow(
      'agent_session_conflict'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('writes the prompt when the TUI owner still holds the lease', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce()

    await expect(runtime.sendTerminalAgentPrompt(handle, 'do the thing')).resolves.toBeDefined()

    expect(write).toHaveBeenCalled()
  })

  it('does not terminate a partial paste after its admitted fence moved', async () => {
    const { runtime, handle, write } = await makeRuntime({
      onWrite: () => publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
    })
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2))
    ).rejects.toThrow('agent_session_checkpoint_stale')

    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('lease transition against an in-flight write', () => {
  const CHUNKED_TEXT = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8)

  it('stops a paste mid-flight once the fence advances under it', async () => {
    let written = 0
    const { runtime, handle, write } = await makeRuntime({
      onWrite: () => {
        written += 1
        if (written === 1) {
          // A handoff completed between the first and second chunk.
          publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
        }
      }
    })
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))

    await expect(runtime.sendTerminal(handle, { text: CHUNKED_TEXT })).rejects.toThrow(
      'agent_session_checkpoint_stale'
    )

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('lets a paste finish while the same owner holds the fence', async () => {
    const { runtime, handle, write } = await makeRuntime()
    enforce()

    await expect(runtime.sendTerminal(handle, { text: CHUNKED_TEXT })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledTimes(3)
  })

  it('fences preview paste chunks to the lease admitted before the first chunk', async () => {
    let written = 0
    const { runtime, write } = await makeRuntime({
      onWrite: () => {
        written += 1
        if (written === 1) {
          publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
        }
      }
    })
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))

    await expect(runtime.writeTerminalPreviewInput(PTY_ID, CHUNKED_TEXT)).resolves.toBe(false)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('withholds the submit when the lease moves during the text/suffix pause', async () => {
    const { runtime, handle, write } = await makeRuntime({
      onWrite: (_ptyId, data) => {
        if (data === 'ls') {
          publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
        }
      }
    })
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))

    await expect(runtime.sendTerminal(handle, { text: 'ls', enter: true })).rejects.toThrow(
      'agent_session_checkpoint_stale'
    )

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalledWith(PTY_ID, '\r')
  })

  it('withholds orchestration Enter after the pointer lease fence moves', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, write } = await makeRuntime({
        onWrite: (_ptyId, data) => {
          if (data.includes('orca orchestration check')) {
            publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
          }
        }
      })
      let messages: { id: string; sequence: number; type: string }[] = []
      // Why run-scoped: pointer delivery only serves `run:` mailboxes, and it stages the
      // batch as delivered before writing — a fake missing either makes the fence
      // assertion below vacuous because nothing is ever written.
      runtime.setOrchestrationDb({
        getUndeliveredUnreadMessages: () => messages,
        getCurrentRunForPane: () => ({ id: RUN_ID }),
        getRun: () => ({ id: RUN_ID, coordinator_handle: handle }),
        markAsDelivered: () => undefined
      } as never)
      runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
      runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
      enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))
      messages = [{ id: 'msg-1', sequence: 1, type: 'status' }]

      runtime.deliverPendingMessagesForHandle(`run:${RUN_ID}`)
      expect(write).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(500)

      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
