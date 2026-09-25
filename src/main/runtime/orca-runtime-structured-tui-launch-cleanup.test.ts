import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { StructuredTuiLaunchCleanupError } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { OrcaRuntimeService } from './orca-runtime'

const { readStructuredTuiProcessIdentity, proveCodexTuiRollout, resolvePinnedCodexRolloutProof } =
  vi.hoisted(() => ({
    readStructuredTuiProcessIdentity: vi.fn(),
    proveCodexTuiRollout: vi.fn(),
    resolvePinnedCodexRolloutProof: vi.fn()
  }))

vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))
vi.mock('../codex/codex-tui-rollout-proof', () => ({
  proveCodexTuiRollout,
  resolvePinnedCodexRolloutProof
}))

const WORKTREE_ID = 'repo-1::/tmp/structured-pid-guard'

function notifier() {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(async () => ({ tabId: 'tab-renderer' })),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

function launchRecord() {
  return {
    sessionId: 'session-pid-guard',
    location: { workspaceId: WORKTREE_ID, executionHostId: 'local' },
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
    providerHandleChain: [{ handle: { provider: 'codex', threadId: 'thread-1' }, observedAt: 1 }]
  } as never
}

function createHarness(args: { ptyExitProvable: boolean }) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    { getAgentStatusSnapshot: () => [] }
  )
  runtime.setNotifier(notifier() as never)
  // Why no pid: this is the daemon-race shape the launch identity guard exists to catch.
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-structured' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)

  const internal = runtime as unknown as Record<string, unknown>
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: WORKTREE_ID,
    path: '/tmp/structured-pid-guard',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.waitForTerminal = vi.fn(async () => ({}))
  internal.waitForAdoptedStructuredTuiProof = vi.fn(async () => ({}))
  const closeTerminal = vi.fn(async () => undefined)
  internal.closeTerminal = closeTerminal
  const waitForStructuredTuiPtyExit = vi.fn(
    args.ptyExitProvable
      ? async () => undefined
      : async () => {
          throw new Error('the PTY could not be proven gone')
        }
  )
  internal.waitForStructuredTuiPtyExit = waitForStructuredTuiPtyExit
  internal.waitForStructuredTuiOwnerExit = vi.fn(async () => undefined)

  const transport = (
    runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
    }
  ).createStructuredAgentSessionHandoffTransport()
  return { transport, closeTerminal, waitForStructuredTuiPtyExit }
}

async function launchFailure(
  transport: StructuredAgentSessionHandoffTransport
): Promise<unknown> {
  return await transport
    .launchTui({
      record: launchRecord(),
      fence: 3,
      spawnToken: 'spawn-token',
      onSpawned: vi.fn(async () => {})
    })
    .then(
      () => null,
      (thrown: unknown) => thrown
    )
}

// A launch that fails its identity guard has already been handed the terminal PTY id, so its
// cleanup can prove that PTY gone. Reporting the cleanup as unprovable instead latches the
// session in manual-recovery with no owner process, which no probe can leave on a host that
// cannot enumerate spawn tokens - stranding the adopted provider conversation permanently.
describe('structured TUI launch cleanup after a missing process identity', () => {
  it('proves the failed PTY exited instead of reporting cleanup as unprovable', async () => {
    const harness = createHarness({ ptyExitProvable: true })

    const error = await launchFailure(harness.transport)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(StructuredTuiLaunchCleanupError)
    expect((error as Error).message).toContain('did not publish a process identity')
    expect(harness.closeTerminal).toHaveBeenCalledOnce()
    expect(harness.waitForStructuredTuiPtyExit).toHaveBeenCalledWith('pty-structured')
  })

  it('still fails closed when that PTY cannot be proven gone', async () => {
    const harness = createHarness({ ptyExitProvable: false })

    const error = await launchFailure(harness.transport)

    expect(error).toBeInstanceOf(StructuredTuiLaunchCleanupError)
    expect(harness.waitForStructuredTuiPtyExit).toHaveBeenCalledWith('pty-structured')
  })
})
