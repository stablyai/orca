import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { createEphemeralAgentSessionClaimSigner } from './agent-session-claim-identity'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { OrcaRuntimeService } from './orca-runtime'

const {
  probeAgentSessionProcessIdentity,
  proveCodexTuiRollout,
  readStructuredTuiProcessIdentity,
  resolvePinnedCodexRolloutProof
} = vi.hoisted(() => ({
  probeAgentSessionProcessIdentity: vi.fn(),
  proveCodexTuiRollout: vi.fn(),
  readStructuredTuiProcessIdentity: vi.fn(),
  resolvePinnedCodexRolloutProof: vi.fn()
}))

vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))
vi.mock('../codex/codex-tui-rollout-proof', () => ({
  proveCodexTuiRollout,
  resolvePinnedCodexRolloutProof
}))
vi.mock('./agent-session-process-identity-probe', async (importOriginal) => ({
  ...(await importOriginal()),
  probeAgentSessionProcessIdentity
}))

const WORKTREE_ID = 'repo-1::/tmp/structured-handoff'

function notifier(revealTerminalSession: ReturnType<typeof vi.fn>) {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession,
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

describe('structured TUI launch tab binding', () => {
  it('recovers a live TUI from durable owner inventory in a fresh runtime', async () => {
    const namespace = {
      machine: 'native:test',
      principal: 'uid:1',
      container: 'native',
      providerRoot: '/tmp/codex-home'
    }
    const signer = createEphemeralAgentSessionClaimSigner('profile-test')
    const claim = signer.createClaim({
      namespace,
      identity: { agent: 'codex', providerSession: { key: 'session_id', id: 'thread-1' } },
      canonicalWorktreeId: WORKTREE_ID
    })
    const terminalHandle = 'term_cold_owner'
    const leafId = '23013912-13f8-44e5-818f-d40a1ff4e8c5'
    resolvePinnedCodexRolloutProof.mockResolvedValue('/tmp/codex-home/sessions/thread-1.jsonl')
    const writeAgentSessionProof = vi.fn(() => false)
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      agentSessionClaimSigner: signer
    })
    runtime.setPtyController({
      listProcesses: vi.fn(async () => [
        {
          id: 'pty-cold-owner',
          incarnationId: 'incarnation-1',
          cwd: '/tmp/structured-handoff',
          title: 'codex',
          worktreeId: WORKTREE_ID,
          terminalHandle,
          agentSessionOwners: [
            {
              claim,
              generation: 'generation-1',
              phase: 'live' as const,
              ptyId: 'pty-cold-owner',
              surface: {
                worktreeId: WORKTREE_ID,
                tabId: 'tab-cold-owner',
                leafId,
                terminalHandle
              }
            }
          ]
        }
      ]),
      write: () => true,
      kill: () => true,
      writeAgentSessionProof,
      getForegroundProcess: async () => null
    })
    const internal = runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      listResolvedWorktrees(): Promise<unknown[]>
      resolveTerminalWorkspaceLaunchScope(): Promise<{
        id: string
        path: string
        connectionId: null
        repo: null
        folderWorkspace: null
      }>
      getAgentSessionExecutionNamespace(): typeof namespace
      ptysById: Map<
        string,
        { launchToken: string | null; launchAgent: string | null; agentSessionOwners: unknown[] }
      >
    }
    internal.listResolvedWorktrees = vi.fn(async () => [
      { id: WORKTREE_ID, repoId: 'repo-1', path: '/tmp/structured-handoff' }
    ])
    internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/tmp/structured-handoff',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }))
    internal.getAgentSessionExecutionNamespace = () => namespace
    probeAgentSessionProcessIdentity.mockResolvedValue({
      outcome: 'identity-matched',
      matchedOn: ['process-start-time']
    })

    await internal.refreshMobileSessionPtyRecords()
    const coldPty = internal.ptysById.get('pty-cold-owner')!
    expect(coldPty).toMatchObject({ launchToken: null, launchAgent: null })
    expect(coldPty.agentSessionOwners).toHaveLength(1)

    const owner = await internal.createStructuredAgentSessionHandoffTransport().recoverTuiOwner({
      sessionId: 'session-1',
      location: { workspaceId: WORKTREE_ID, executionHostId: 'local' },
      accountHome: { variable: 'CODEX_HOME', path: namespace.providerRoot },
      providerHandleChain: [{ handle: { provider: 'codex', threadId: 'thread-1' }, observedAt: 1 }],
      lease: {
        ownerProcess: {
          hostId: 'local',
          pid: 4243,
          processStartTimeMs: 10,
          spawnToken: 'spawn-token'
        },
        runtimeFence: 3
      }
    } as never)

    expect(owner.terminal).toEqual({
      handle: terminalHandle,
      tabId: 'tab-cold-owner',
      paneKey: `tab-cold-owner:${leafId}`,
      ptyId: 'pty-cold-owner'
    })
    expect(resolvePinnedCodexRolloutProof).toHaveBeenCalledWith(namespace.providerRoot, 'thread-1')
    expect(writeAgentSessionProof).not.toHaveBeenCalled()
    expect(agentSessionPtyWriteGate.boundSessionId('pty-cold-owner')).toBe('session-1')
    agentSessionPtyWriteGate.unbindPty('pty-cold-owner')
  })

  it('rebuilds a Claude proving link from current launch-token-bound hook evidence', async () => {
    const paneKey = 'tab-claude:leaf-claude'
    const spawnToken = 'claude-restart-token'
    const sessionId = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
    const transcriptPath = '/tmp/claude-home/projects/worktree/session.jsonl'
    const attestAgentHookCompatibilityAuthority = vi.fn(() => ({
      paneKey,
      source: 'hydrated_commitment' as const
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      attestAgentHookCompatibilityAuthority,
      getAgentProviderSessionRowsForPane: () => [
        {
          paneKey,
          connectionId: null,
          state: 'done',
          prompt: '',
          agentType: 'claude',
          receivedAt: 10,
          stateStartedAt: 10,
          providerSession: { key: 'session_id', id: sessionId, transcriptPath }
        }
      ]
    })
    const internal = runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
      ptysById: Map<string, unknown>
    }
    internal.ptysById.set('pty-claude', {
      ptyId: 'pty-claude',
      worktreeId: WORKTREE_ID,
      connectionId: null,
      tabId: 'tab-claude',
      paneKey,
      launchToken: spawnToken,
      launchAgent: 'claude',
      connected: true
    })
    const record = {
      sessionId: 'session-1',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/tmp/claude-home' },
      providerHandleChain: [
        {
          linkId: 'claude-old',
          handle: { provider: 'claude', sessionId, leafUuid: 'leaf-before-resume' },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        }
      ],
      lease: {
        runtimeFence: 3,
        ownerProcess: {
          hostId: 'local',
          pid: 4343,
          processStartTimeMs: 20,
          spawnToken
        },
        provenHandleLinkId: null
      }
    } as never
    probeAgentSessionProcessIdentity.mockResolvedValue({
      outcome: 'identity-matched',
      matchedOn: ['process-start-time']
    })

    const transport = internal.createStructuredAgentSessionHandoffTransport()
    const recovered = await transport.recoverTuiOwner(record)
    const reproved = await transport.reproveTuiOwner({ record, owner: recovered })

    expect(reproved).toMatchObject({
      transcriptPath,
      link: {
        handle: { provider: 'claude', sessionId, leafUuid: 'leaf-before-resume' },
        origin: 'resumed',
        mintedAtFence: 3
      }
    })
    expect(reproved.link.linkId).not.toBe('claude-old')
    expect(attestAgentHookCompatibilityAuthority).not.toHaveBeenCalled()
    expect(agentSessionPtyWriteGate.boundSessionId('pty-claude')).toBe('session-1')
    agentSessionPtyWriteGate.unbindPty('pty-claude')
  })

  it('requires restored hook attestation after the runtime restarts', async () => {
    const paneKey = 'tab-restored:leaf-restored'
    const spawnToken = 'restored-token'
    const sessionId = '019fd532-7c11-7a90-b6de-4e1a2c3d5f62'
    const transcriptPath = '/tmp/claude-home/projects/worktree/restored.jsonl'
    const attestAgentHookCompatibilityAuthority = vi.fn(() => ({
      paneKey,
      source: 'hydrated_commitment' as const
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      attestAgentHookCompatibilityAuthority,
      getAgentProviderSessionRowsForPane: () => [
        {
          paneKey,
          connectionId: null,
          state: 'done',
          prompt: '',
          agentType: 'claude',
          receivedAt: 10,
          stateStartedAt: 10,
          providerSession: { key: 'session_id', id: sessionId, transcriptPath }
        }
      ]
    })
    const internal = runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
      ptysById: Map<string, unknown>
      restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
    }
    internal.ptysById.set('pty-restored', {
      ptyId: 'pty-restored',
      worktreeId: WORKTREE_ID,
      connectionId: null,
      tabId: 'tab-restored',
      paneKey,
      launchToken: spawnToken,
      launchAgent: 'claude',
      connected: true
    })
    internal.restoredOrchestrationAuthorityByPtyId.set('pty-restored', {})
    const record = {
      sessionId: 'session-restored',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/tmp/claude-home' },
      providerHandleChain: [
        {
          linkId: 'claude-restored',
          handle: { provider: 'claude', sessionId, leafUuid: 'leaf-restored' },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        }
      ],
      lease: {
        runtimeFence: 4,
        ownerProcess: {
          hostId: 'local',
          pid: 4545,
          processStartTimeMs: 30,
          spawnToken
        },
        provenHandleLinkId: null
      }
    } as never

    await internal.createStructuredAgentSessionHandoffTransport().recoverTuiOwner(record)

    expect(attestAgentHookCompatibilityAuthority).toHaveBeenCalledWith({
      paneKey,
      launchTokenHash: createHash('sha256').update(spawnToken).digest('hex'),
      connectionId: null,
      terminalProvenance: 'restored'
    })
    attestAgentHookCompatibilityAuthority.mockReturnValueOnce(null as never)
    await expect(
      internal.createStructuredAgentSessionHandoffTransport().recoverTuiOwner(record)
    ).rejects.toThrow('launch-token authority')
    agentSessionPtyWriteGate.unbindPty('pty-restored')
  })

  it('proves the published launch tab before returning its revealed renderer binding', async () => {
    let explicitStatus: {
      state: 'working' | 'done'
      prompt: string
      receivedAt: number
      stateStartedAt: number
      paneKey: string
      terminalHandle: string
    } | null = null
    const revealTerminalSession = vi.fn(
      (_worktreeId: string, _options: { tabId?: string; leafId?: string; ptyId?: string }) =>
        Promise.resolve({ tabId: 'tab-renderer' })
    )
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          disabledTuiAgents: [],
          agentCmdOverrides: {},
          agentDefaultArgs: {
            codex: '-m gpt-5.6-sol -c model_reasoning_effort=high'
          },
          agentDefaultEnv: {}
        })
      } as never,
      undefined,
      {
        getAgentStatusSnapshot: () => (explicitStatus ? [explicitStatus as never] : [])
      }
    )
    runtime.setNotifier(notifier(revealTerminalSession) as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-structured', pid: 4242 })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const internal = runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
      resolveTerminalWorkspaceLaunchScope(): Promise<{
        id: string
        path: string
        connectionId: null
        repo: null
        folderWorkspace: null
      }>
      markLocalWorkspaceTrustedForAgent(): void
      waitForTerminal(): Promise<unknown>
      waitForStructuredTuiProof(): Promise<{ transcriptPath?: string }>
      waitForStructuredTuiPtyExit(): Promise<void>
      closeTerminal(handle: string): Promise<unknown>
      handles: Map<
        string,
        {
          rendererGraphEpoch: number
          tabId: string
          leafId: string
        }
      >
      graphStatus: 'ready'
    }
    internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/tmp/structured-handoff',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }))
    internal.markLocalWorkspaceTrustedForAgent = vi.fn()
    const waitForTerminal = vi.fn(async () => ({}))
    internal.waitForTerminal = waitForTerminal
    const waitForStructuredTuiProof = vi.fn(async () => {
      const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(snapshot.tabs).toContainEqual(
        expect.objectContaining({
          type: 'terminal',
          parentTabId: expect.any(String),
          leafId: expect.any(String),
          ptyId: 'pty-structured',
          terminal: expect.any(String)
        })
      )
      expect(revealTerminalSession).not.toHaveBeenCalled()
      return { transcriptPath: '/tmp/rollout.jsonl' }
    })
    internal.waitForStructuredTuiProof = waitForStructuredTuiProof
    const waitForStructuredTuiPtyExit = vi.fn(async () => {})
    internal.waitForStructuredTuiPtyExit = waitForStructuredTuiPtyExit
    const closeTerminal = vi.fn(async () => undefined)
    internal.closeTerminal = closeTerminal
    readStructuredTuiProcessIdentity.mockResolvedValue({
      hostId: 'local',
      pid: 4243,
      processStartTimeMs: 10,
      spawnToken: 'spawn-token'
    })
    probeAgentSessionProcessIdentity.mockResolvedValue({
      outcome: 'identity-matched',
      matchedOn: ['process-start-time']
    })

    const transport = internal.createStructuredAgentSessionHandoffTransport()
    const onSpawned = vi.fn(async () => {})
    const owner = await transport.launchTui({
      record: {
        sessionId: 'session-1',
        location: { workspaceId: WORKTREE_ID, executionHostId: 'local' },
        accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
        options: { model: 'gpt-5.6-terra', effort: 'medium' },
        providerHandleChain: [
          { handle: { provider: 'codex', threadId: 'thread-1' }, observedAt: 1 }
        ]
      } as never,
      fence: 3,
      spawnToken: 'spawn-token',
      onSpawned
    })

    const reveal = revealTerminalSession.mock.calls[0]?.[1] as {
      tabId: string
      leafId: string
    }
    expect(owner.terminal).toMatchObject({
      tabId: 'tab-renderer',
      paneKey: `${reveal.tabId}:${reveal.leafId}`,
      ptyId: 'pty-structured'
    })
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ condition: 'tui-idle' })
    )
    expect(waitForStructuredTuiProof).toHaveBeenCalledOnce()
    expect(onSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({ ptyId: 'pty-structured' }),
        process: expect.objectContaining({ spawnToken: 'spawn-token' })
      })
    )
    expect(onSpawned.mock.invocationCallOrder[0]).toBeLessThan(
      waitForTerminal.mock.invocationCallOrder[0]!
    )
    expect(waitForStructuredTuiProof.mock.invocationCallOrder[0]).toBeLessThan(
      revealTerminalSession.mock.invocationCallOrder[0]!
    )
    const launchCommand = spawn.mock.calls[0]?.[0]?.command
    expect(launchCommand).toContain("'-m' 'gpt-5.6-terra'")
    expect(launchCommand).toContain("'-c' 'model_reasoning_effort=medium'")
    expect(launchCommand).not.toContain('gpt-5.6-sol')
    expect(launchCommand).not.toContain('model_reasoning_effort=high')

    Object.assign(internal.handles.get(owner.terminal.handle)!, {
      rendererGraphEpoch: -1,
      tabId: 'tab-retired',
      leafId: 'leaf-retired'
    })
    internal.graphStatus = 'ready'

    explicitStatus = {
      state: 'working',
      prompt: '',
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      paneKey: owner.terminal.paneKey,
      terminalHandle: owner.terminal.handle
    }
    expect(transport.tuiStatus(owner)).toBe('busy')
    await expect(
      transport.waitForTuiIdleOrExit(owner, new AbortController().signal)
    ).resolves.toBeNull()

    explicitStatus = { ...explicitStatus, state: 'done', receivedAt: Date.now() }
    expect(transport.tuiStatus(owner)).toBe('idle')
    await expect(transport.waitForTuiIdleOrExit(owner, new AbortController().signal)).resolves.toBe(
      'idle'
    )

    explicitStatus = null
    const livePty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            tailBuffer: string[]
            tailPartialLine: string
            preview: string
            lastAgentStatus: null
            lastAgentStatusObservedLive: boolean
          }
        >
      }
    ).ptysById.get('pty-structured')!
    Object.assign(livePty, {
      tailBuffer: [
        'OpenAI Codex (v0.147.0)',
        'model: gpt-5.6-terra',
        'directory: /tmp/structured-handoff'
      ],
      tailPartialLine: '',
      preview: '',
      lastAgentStatus: null,
      lastAgentStatusObservedLive: false
    })
    expect(transport.tuiStatus(owner)).toBe('idle')
    await expect(transport.waitForTuiIdleOrExit(owner, new AbortController().signal)).resolves.toBe(
      'idle'
    )

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { connected: boolean; launchToken: string | null }>
      }
    ).ptysById.get('pty-structured')!
    pty.launchToken = null
    const persistedRecord = {
      sessionId: 'session-1',
      providerHandleChain: [{ handle: { provider: 'codex', threadId: 'thread-1' }, observedAt: 1 }],
      lease: { ownerProcess: owner.process, provenHandleLinkId: owner.link.linkId }
    } as never

    const rebound = await transport.reproveTuiOwner({ record: persistedRecord, owner })
    expect(rebound.terminal).toMatchObject({
      ptyId: 'pty-structured',
      tabId: owner.terminal.tabId,
      paneKey: owner.terminal.paneKey
    })
    expect(rebound.terminal.handle).not.toBe(owner.terminal.handle)
    await transport.waitForTuiExit(rebound, async () => {})
    expect(waitForStructuredTuiPtyExit).toHaveBeenCalledWith('pty-structured')
    expect(waitForStructuredTuiProof).toHaveBeenCalledOnce()

    await expect(transport.closeTuiOwner?.(rebound)).resolves.toEqual({
      transcriptPath: '/tmp/rollout.jsonl'
    })
    expect(closeTerminal).toHaveBeenCalledWith(rebound.terminal.handle)

    explicitStatus = null
    pty.connected = false
    await expect(
      transport.waitForTuiIdleOrExit(rebound, new AbortController().signal)
    ).resolves.toBe('exited')
    await expect(transport.stopFailedTuiLaunch?.(rebound)).resolves.toBeUndefined()
  })
})
