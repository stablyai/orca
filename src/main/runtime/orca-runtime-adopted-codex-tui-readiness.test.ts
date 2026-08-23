import { describe, expect, it, vi } from 'vitest'
import { AGENT_HOOK_SESSION_NONCE_ENV_VAR } from '../../shared/agent-hook-session-nonce'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { AdoptedCodexReadinessEvent } from '../codex/adopted-codex-tui-readiness'
import { OrcaRuntimeService } from './orca-runtime'

const { proveCodexTuiRollout, readStructuredTuiProcessIdentity, resolvePinnedCodexRolloutProof } =
  vi.hoisted(() => ({
    proveCodexTuiRollout: vi.fn(),
    readStructuredTuiProcessIdentity: vi.fn(),
    resolvePinnedCodexRolloutProof: vi.fn()
  }))

vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))
vi.mock('../codex/codex-tui-rollout-proof', () => ({
  proveCodexTuiRollout,
  resolveLiveCodexTuiRollout: vi.fn(),
  resolvePinnedCodexRolloutProof
}))

const WORKTREE_ID = 'repo-1::/tmp/adopted-readiness'
const PANE_KEY = 'tab-adopt:leaf-adopt'
const THREAD_ID = 'thread-adopt'
const SESSION_ID = 'session-adopt'
const TRANSCRIPT = '/tmp/codex-home/rollout.jsonl'

/** The tail a bare shell leaves behind once adoption has stopped the pane's Codex. */
const READY_SHELL_TAIL = ['dev@host ~/repo %']

function returnToTerminalHarness(settingsOverrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: AdoptedCodexReadinessEvent) => void>()
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        ...settingsOverrides
      })
    } as never,
    undefined,
    {
      subscribeAgentHookEvents: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  )
  const writeAgentSessionProof = vi.fn(() => true)
  runtime.setPtyController({
    writeAgentSessionProof,
    listProcesses: async () => [
      { id: 'pty-adopt', incarnationId: 'inc-adopt', rootProcessId: 31337 }
    ]
  } as never)

  const internal = runtime as unknown as {
    ptysById: Map<string, unknown>
    adoptedStructuredTuiOwners: Map<string, unknown>
    resolveTerminalWorkspaceLaunchScope(): Promise<unknown>
    createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
  }
  internal.ptysById.set('pty-adopt', {
    ptyId: 'pty-adopt',
    connected: true,
    connectionId: null,
    wslDistro: null,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    incarnationId: 'inc-adopt',
    // Decoys: exactly the two signals a `tui-idle` wait would settle on.
    lastAgentStatus: 'idle',
    tailBuffer: READY_SHELL_TAIL,
    tailPartialLine: '',
    preview: READY_SHELL_TAIL.join('\n'),
    lastOutputAt: 1_700_000_000_000
  })
  internal.adoptedStructuredTuiOwners.set(SESSION_ID, {
    terminal: {
      handle: 'term-adopt',
      tabId: 'tab-adopt',
      paneKey: PANE_KEY,
      ptyId: 'pty-adopt'
    },
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 10, spawnToken: 'spawn-adopt' },
    link: {
      linkId: 'link-adopt',
      handle: { provider: 'codex', threadId: THREAD_ID },
      origin: 'adopted',
      mintedAtFence: 1,
      observedAt: 1
    },
    historySource: 'provider-resume',
    adoptedTerminal: true
  })
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: WORKTREE_ID,
    path: '/tmp/adopted-readiness',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))

  readStructuredTuiProcessIdentity.mockResolvedValue({
    hostId: 'local',
    pid: 5252,
    processStartTimeMs: 20,
    spawnToken: 'spawn-adopt'
  })
  resolvePinnedCodexRolloutProof.mockResolvedValue(TRANSCRIPT)

  const launch = (): Promise<{ transcriptPath?: string }> =>
    internal.createStructuredAgentSessionHandoffTransport().launchTui({
      record: {
        sessionId: SESSION_ID,
        location: { workspaceId: WORKTREE_ID, executionHostId: 'local' },
        accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
        options: null,
        providerHandleChain: [{ handle: { provider: 'codex', threadId: THREAD_ID }, observedAt: 1 }]
      } as never,
      fence: 3,
      spawnToken: 'spawn-adopt'
    }) as Promise<{ transcriptPath?: string }>

  const writtenNonce = (): string => {
    const written = writeAgentSessionProof.mock.calls
      .map((call) => (call as unknown as [string, string])[1])
      .join('')
    const match = new RegExp(`${AGENT_HOOK_SESSION_NONCE_ENV_VAR}[=:']*([0-9a-f-]{36})`).exec(
      written
    )
    if (!match?.[1]) {
      throw new Error(`no session nonce in written command: ${written}`)
    }
    return match[1]
  }

  const emit = (event: Partial<AdoptedCodexReadinessEvent>): void => {
    const full = {
      paneKey: PANE_KEY,
      source: 'codex',
      hookEventName: 'SessionStart',
      providerSession: { key: 'session_id', id: THREAD_ID },
      ...event
    } as AdoptedCodexReadinessEvent
    for (const listener of Array.from(listeners)) {
      listener(full)
    }
  }

  return { runtime, launch, emit, writtenNonce, writeAgentSessionProof }
}

/** Resolves to `'pending'` unless `promise` settles first. */
async function settlesBefore<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 0)
    })
  ])
}

describe('returning an adopted Codex session to its terminal', () => {
  it('does not accept a ready shell as the resumed Codex, only its SessionStart hook', async () => {
    const rig = returnToTerminalHarness()
    const owner = rig.launch()
    const stillWaiting = owner.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )

    // The pane now looks exactly like a settled agent terminal: an idle status
    // left over from the Codex adoption stopped, and a shell prompt on screen.
    expect(await settlesBefore(stillWaiting)).toBe('pending')
    expect(proveCodexTuiRollout).not.toHaveBeenCalled()

    rig.emit({ sessionNonce: rig.writtenNonce() })
    await expect(owner).resolves.toMatchObject({ transcriptPath: TRANSCRIPT })
  })

  it('stamps a one-shot nonce into the resume command and ignores a SessionStart without it', async () => {
    const rig = returnToTerminalHarness()
    const owner = rig.launch()
    const stillWaiting = owner.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await settlesBefore(stillWaiting)
    const nonce = rig.writtenNonce()

    // A SessionStart from an earlier Codex in this pane: same pane, same thread,
    // a nonce Orca minted for some other invocation.
    rig.emit({ sessionNonce: `stale-${nonce}` })
    expect(await settlesBefore(stillWaiting)).toBe('pending')

    rig.emit({ sessionNonce: nonce })
    await expect(owner).resolves.toMatchObject({ transcriptPath: TRANSCRIPT })
  })

  it('ignores non-SessionStart codex hooks and replayed ones', async () => {
    const rig = returnToTerminalHarness()
    const owner = rig.launch()
    const stillWaiting = owner.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await settlesBefore(stillWaiting)
    const sessionNonce = rig.writtenNonce()

    rig.emit({ sessionNonce, hookEventName: 'Stop' })
    rig.emit({ sessionNonce, hookEventName: 'UserPromptSubmit' })
    rig.emit({ sessionNonce, isReplay: true })
    rig.emit({ sessionNonce, source: 'claude' })
    rig.emit({ sessionNonce, paneKey: 'tab-other:leaf-other' })
    expect(await settlesBefore(stillWaiting)).toBe('pending')

    rig.emit({ sessionNonce })
    await expect(owner).resolves.toMatchObject({ transcriptPath: TRANSCRIPT })
  })

  it('rejects when the nonce Orca minted comes back bound to another conversation', async () => {
    const rig = returnToTerminalHarness()
    const owner = rig.launch()
    const settled = owner.catch((error: Error) => error.message)
    await settlesBefore(settled)

    rig.emit({
      sessionNonce: rig.writtenNonce(),
      providerSession: { key: 'session_id', id: 'thread-other' }
    })
    await expect(settled).resolves.toContain('resumed a different Codex session')
  })

  it('says why it cannot confirm the session when agent status hooks are off', async () => {
    const rig = returnToTerminalHarness({ agentStatusHooksEnabled: false })
    await expect(rig.launch()).rejects.toThrow('Agent status hooks are off')
    // Nothing may be typed at the pane when the proof can never arrive.
    expect(rig.writeAgentSessionProof).not.toHaveBeenCalled()
  })

  it('never types a screen probe at the pane', async () => {
    const rig = returnToTerminalHarness()
    const owner = rig.launch()
    const stillWaiting = owner.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await settlesBefore(stillWaiting)
    rig.emit({ sessionNonce: rig.writtenNonce() })
    await owner

    const written = rig.writeAgentSessionProof.mock.calls.map(
      (call) => (call as unknown as [string, string])[1]
    )
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('codex')
    expect(written[0]).not.toContain('/status')
    // Bracketed paste and the bare/kitty submit keys the old proof sent.
    expect(written[0]).not.toContain('[200~')
    expect(written[0]).not.toContain('[13u')
    expect(proveCodexTuiRollout).not.toHaveBeenCalled()
  })
})
