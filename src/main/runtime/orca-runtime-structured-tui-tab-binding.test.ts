import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
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

function structuredTabNotifier() {
  return {
    ...notifier(vi.fn()),
    focusEditorTab: vi.fn()
  }
}

describe('structured TUI launch tab binding', () => {
  it('reveals the structured chat tab when reverse handoff completes', () => {
    const runtime = new OrcaRuntimeService()
    const targetNotifier = structuredTabNotifier()
    runtime.setNotifier(targetNotifier as never)
    const transport = (
      runtime as unknown as {
        createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
      }
    ).createStructuredAgentSessionHandoffTransport()

    transport.revealNativeSession?.({ workspaceId: WORKTREE_ID, sessionId: 'session-1' })

    expect(targetNotifier.focusEditorTab).toHaveBeenCalledWith(
      'structured-agent-session-session-1',
      WORKTREE_ID
    )
  })

  it.each([
    {
      restoreMode: 'development reload',
      durableTerminalHandle: 'term_current_runtime',
      persistedIncarnationId: 'incarnation-1'
    },
    {
      restoreMode: 'packaged restart',
      durableTerminalHandle: 'term_previous_runtime',
      persistedIncarnationId: 'incarnation-1'
    },
    {
      restoreMode: 'packaged restart before incarnation hydration',
      durableTerminalHandle: 'term_previous_runtime',
      persistedIncarnationId: null
    }
  ])(
    'recovers a live TUI after a $restoreMode with current runtime routing',
    async ({ durableTerminalHandle, persistedIncarnationId }) => {
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
      const terminalHandle = 'term_current_runtime'
      const leafId = '23013912-13f8-44e5-818f-d40a1ff4e8c5'
      const conflictingLeafId = '33013912-13f8-44e5-818f-d40a1ff4e8c5'
      resolvePinnedCodexRolloutProof.mockResolvedValue('/tmp/codex-home/sessions/thread-1.jsonl')
      const writeAgentSessionProof = vi.fn(() => false)
      const persistedSession = {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: 'tab-cold-owner',
              ptyId: 'pty-cold-owner',
              worktreeId: WORKTREE_ID,
              title: 'Codex',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'tab-cold-owner': {
            root: { type: 'leaf' as const, leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'pty-cold-owner' }
          }
        },
        terminalPtyIncarnationsByPaneKey: persistedIncarnationId
          ? { [`tab-cold-owner:${leafId}`]: persistedIncarnationId }
          : {}
      }
      const runtime = new OrcaRuntimeService(
        { getWorkspaceSession: () => persistedSession } as never,
        undefined,
        {
          agentSessionClaimSigner: signer
        }
      )
      runtime.setPtyController({
        listProcesses: vi.fn(async () => [
          {
            id: 'pty-cold-owner',
            incarnationId: 'incarnation-1',
            rootProcessId: 31337,
            cwd: '/tmp/structured-handoff',
            title: 'codex',
            worktreeId: WORKTREE_ID,
            terminalHandle: durableTerminalHandle,
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
                  terminalHandle: durableTerminalHandle
                }
              }
            ]
          },
          {
            id: 'pty-conflicting-owner',
            incarnationId: 'incarnation-2',
            rootProcessId: 41337,
            cwd: '/tmp/structured-handoff',
            title: 'codex',
            worktreeId: WORKTREE_ID,
            terminalHandle: 'term_conflicting_runtime',
            agentSessionOwners: [
              {
                claim,
                generation: 'generation-2',
                phase: 'live' as const,
                ptyId: 'pty-conflicting-owner',
                surface: {
                  worktreeId: WORKTREE_ID,
                  tabId: 'tab-conflicting-owner',
                  leafId: conflictingLeafId,
                  terminalHandle: 'term_conflicting_runtime'
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
      runtime.registerPreAllocatedHandleForPty('pty-cold-owner', terminalHandle)
      probeAgentSessionProcessIdentity.mockResolvedValue({
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      })
      readStructuredTuiProcessIdentity.mockResolvedValue({
        hostId: 'local',
        pid: 4243,
        processStartTimeMs: 10,
        spawnToken: 'spawn-token'
      })

      await internal.refreshMobileSessionPtyRecords()
      const coldPty = internal.ptysById.get('pty-cold-owner')!
      expect(coldPty).toMatchObject({ launchToken: null, launchAgent: null })
      expect(coldPty.agentSessionOwners).toHaveLength(1)

      const owner = await internal.createStructuredAgentSessionHandoffTransport().recoverTuiOwner({
        sessionId: 'session-1',
        location: { workspaceId: WORKTREE_ID, executionHostId: 'local' },
        accountHome: { variable: 'CODEX_HOME', path: namespace.providerRoot },
        providerHandleChain: [
          { handle: { provider: 'codex', threadId: 'thread-1' }, observedAt: 1 }
        ],
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
      if (durableTerminalHandle !== terminalHandle) {
        expect(owner.terminal.handle).not.toBe(durableTerminalHandle)
      }
      expect(resolvePinnedCodexRolloutProof).toHaveBeenCalledWith(
        namespace.providerRoot,
        'thread-1'
      )
      expect(writeAgentSessionProof).not.toHaveBeenCalled()
      expect(readStructuredTuiProcessIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ rootPid: 31337, spawnToken: 'spawn-token' })
      )
      expect(agentSessionPtyWriteGate.boundSessionId('pty-cold-owner')).toBe('session-1')
      expect(agentSessionPtyWriteGate.boundSessionId('pty-conflicting-owner')).toBeNull()
      agentSessionPtyWriteGate.unbindPty('pty-cold-owner')
    }
  )

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
      spawnToken: 'spawn-token'
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
    await transport.waitForTuiExit(rebound)
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
