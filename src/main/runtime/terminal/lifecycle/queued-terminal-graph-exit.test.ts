import { describe, expect, it, vi } from 'vitest'

import { OrcaRuntimeService } from '../../orca-runtime'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { killAllProcessesForWorktrees } from '../../workspaces/removal/worktree-batch-teardown'
import { worktreeRemovalTargetKey } from '../../workspaces/removal/worktree-removal-targets'
import * as sessionRegistry from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { ptyIncarnationById } from '../../../ipc/pty/provider/ownership-state'

const WORKTREE = 'repo::/tmp/graph-exit'
const TAB = '10000000-0000-4000-8000-000000000001'
const LEAF = '10000000-0000-4000-8000-000000000002'
const PTY = `${WORKTREE}@@terminal`
const FIRST = '10000000-0000-4000-8000-000000000003'
const NEXT = '10000000-0000-4000-8000-000000000004'

class ExitAuthorityRuntime extends OrcaRuntimeService {
  override resolveGitWorktreeSelector(selector: string) {
    return super.resolveGitWorktreeSelector(selector)
  }

  override getResolvedWorktreeMap() {
    return super.getResolvedWorktreeMap()
  }

  delayRetirement(completion: Promise<void>, started?: () => void): void {
    const retire = this.retireMobileSessionSurfacesForPty.bind(this)
    this.retireMobileSessionSurfacesForPty = (...args) => {
      void retire(...args)
      started?.()
      return completion
    }
  }

  capture(id = PTY) {
    const pty = this.ptysById.get(id)
    return { connected: pty?.connected, incarnationId: pty?.incarnationId }
  }

  get verdictCount(): number {
    return this.ptyLivenessVerdictByPtyId.size
  }

  dropRecord(id = PTY): void {
    this.dropDisconnectedPtyRecord(id)
  }

  history() {
    return {
      surfaces: this.mobileSessionTabsByWorktree.get(WORKTREE)?.tabs.length,
      leaves: this.getLeavesForPty(PTY).map((leaf) => ({
        connected: leaf.connected,
        writable: leaf.writable
      })),
      model: this.headlessTerminals.has(PTY)
    }
  }
}

function graph(
  runtime: OrcaRuntimeService,
  ptyId: string | null = PTY,
  snapshotVersion?: number
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: TAB, worktreeId: WORKTREE, title: 'terminal', activeLeafId: LEAF, layout: null }
    ],
    leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId }],
    ...(snapshotVersion === undefined
      ? {}
      : {
          mobileSessionTabs: [
            {
              worktree: WORKTREE,
              publicationEpoch: 'renderer:retained-history',
              snapshotVersion,
              activeGroupId: null,
              activeTabId: `${TAB}::${LEAF}`,
              activeTabType: 'terminal' as const,
              tabs: [
                {
                  type: 'terminal' as const,
                  id: `${TAB}::${LEAF}`,
                  parentTabId: TAB,
                  leafId: LEAF,
                  ...(ptyId ? { ptyId } : {}),
                  title: 'Terminal',
                  isActive: true
                }
              ]
            }
          ]
        })
  })
}

function register(runtime: OrcaRuntimeService, incarnationId = FIRST): void {
  runtime.registerPty(PTY, WORKTREE, null, { tabId: TAB, leafId: LEAF, incarnationId })
}

describe('host exit authority over queued renderer graphs', () => {
  it.each(['unrelated-exits', 'failed-retirement', 'successor'] as const)(
    'retains captured real retirement across %s without replay or successor cleanup',
    async (control) => {
      const runtime = new ExitAuthorityRuntime()
      graph(runtime, null)
      const target = { worktreeId: WORKTREE, connectionId: null }
      const id = `${WORKTREE}@@control`
      const before = ptyIncarnationById.get(id)
      const { promise: gate, reject } = Promise.withResolvers<void>()
      if (control === 'failed-retirement') {
        runtime.delayRetirement(gate)
      }
      let live = true
      const exit = vi.spyOn(runtime, 'onPtyExit')
      const clear = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real batch uses only the process inventory and controlled owner shutdown here.
      const provider = {
        listProcesses: async () =>
          live ? [{ id, worktreeId: WORKTREE, incarnationId: FIRST, cwd: '', title: '' }] : [],
        shutdown: async () => {
          live = false
          const retirement = runtime.onPtyExit(id, 0, FIRST, { providerExitObserved: true })
          if (control === 'failed-retirement') {
            reject(new Error('durable write failed'))
          }
          await retirement
          if (control === 'unrelated-exits') {
            for (let index = 0; index < 257; index++) {
              await runtime.onPtyExit(`unrelated-${index}`, 0, `inc-${index}`, {
                providerExitObserved: true
              })
            }
          }
          if (control === 'successor') {
            ptyIncarnationById.set(id, NEXT)
          }
        }
      } as unknown as IPtyProvider
      try {
        const result = await killAllProcessesForWorktrees([target], {
          runtime,
          localProvider: provider,
          onPtyStopped: clear
        })
        expect(result.get(worktreeRemovalTargetKey(target))).toBe(control === 'unrelated-exits')
        expect(exit.mock.calls.filter(([called]) => called === id)).toHaveLength(1)
        expect(clear).toHaveBeenCalledTimes(control === 'unrelated-exits' ? 1 : 0)
        if (control === 'unrelated-exits') {
          expect(runtime.getPtyLivenessVerdict(id)).toBeNull()
        }
        if (control === 'successor') {
          expect(ptyIncarnationById.get(id)).toBe(NEXT)
        }
      } finally {
        if (before === undefined) {
          ptyIncarnationById.delete(id)
        } else {
          ptyIncarnationById.set(id, before)
        }
      }
    }
  )

  it.each([false, true])(
    'requires an observed legacy exit beyond final absence (observed: %s)',
    async (observed) => {
      const runtime = new ExitAuthorityRuntime()
      graph(runtime, null)
      const target = { worktreeId: WORKTREE, connectionId: null }
      const id = `${WORKTREE}@@legacy`
      let live = true
      const listeners = new Set<
        (event: { id: string; code: number; incarnationId: string }) => void
      >()
      const clear = vi.fn()
      const exit = vi.spyOn(runtime, 'onPtyExit')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this legacy shape drives production shutdown evidence, batch and runtime retirement.
      const provider = {
        listProcesses: async () =>
          live ? [{ id, worktreeId: WORKTREE, incarnationId: FIRST, cwd: '', title: '' }] : [],
        supportsFencedTermination: () => false,
        killFenced: vi.fn(),
        onExit: (
          listener: (event: { id: string; code: number; incarnationId: string }) => void
        ) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        shutdown: async () => {
          live = false
          if (observed) {
            for (const listener of listeners) {
              listener({ id, code: 0, incarnationId: FIRST })
            }
            await runtime.onPtyExit(id, 0, FIRST, { providerExitObserved: true })
          }
        }
      } as unknown as IPtyProvider
      const result = await killAllProcessesForWorktrees([target], {
        runtime,
        localProvider: provider,
        onPtyStopped: clear
      })
      expect(result.get(worktreeRemovalTargetKey(target))).toBe(observed)
      expect(exit).toHaveBeenCalledTimes(observed ? 1 : 0)
      expect(clear).toHaveBeenCalledTimes(observed ? 1 : 0)
      expect(provider.killFenced).not.toHaveBeenCalled()
    }
  )

  it.each(['successor', 'duplicate-conflict', 'changed-owner', 'unidentified'] as const)(
    'retains final provider %s evidence without replay or collateral cleanup',
    async (control) => {
      const runtime = new ExitAuthorityRuntime()
      graph(runtime, null)
      const target = { worktreeId: WORKTREE, connectionId: null }
      const id = `${WORKTREE}@@provider-only`
      const sibling = `${WORKTREE}@@independent`
      const live = new Set([id, sibling])
      const row = (ptyId: string) => ({
        id: ptyId,
        worktreeId: WORKTREE,
        incarnationId: FIRST,
        cwd: '',
        title: ''
      })
      const finalRows =
        control === 'duplicate-conflict'
          ? [{ ...row(id), incarnationId: NEXT }, row(id)]
          : [
              {
                ...row(id),
                ...(control === 'changed-owner'
                  ? { worktreeId: 'folder:other' }
                  : { incarnationId: control === 'unidentified' ? undefined : NEXT })
              }
            ]
      const clear = vi.fn()
      const exit = vi.spyOn(runtime, 'onPtyExit')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: controlled inventory and shutdown drive the real batch and runtime retirement.
      const provider = {
        listProcesses: async () => (live.size ? [...live].map(row) : finalRows),
        shutdown: async (ptyId: string) => {
          live.delete(ptyId)
          await runtime.onPtyExit(ptyId, 0, FIRST, { providerExitObserved: true })
        }
      } as unknown as IPtyProvider
      const result = await killAllProcessesForWorktrees([target], {
        runtime,
        localProvider: provider,
        onPtyStopped: clear
      })
      expect(result.get(worktreeRemovalTargetKey(target))).toBe(false)
      expect(exit.mock.calls.map(([ptyId]) => ptyId)).toEqual([id, sibling])
      expect(clear.mock.calls).toEqual([[sibling]])
      expect(ptyIncarnationById.has(id)).toBe(false)
      expect(runtime.capture(id).incarnationId).toBeUndefined()
      expect(await provider.listProcesses()).toEqual(finalRows)
    }
  )

  it.each([false, true])(
    'awaits real missing-event retirement before final membership (late member: %s)',
    async (lateMember) => {
      const runtime = new ExitAuthorityRuntime()
      graph(runtime, PTY, 1)
      register(runtime)
      const target = { worktreeId: WORKTREE, connectionId: null }
      const rows: AgentSessionRecord[] = []
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no initial structured members exist; the final capture only observes the supplied detached record.
      const host = {
        deps: {
          store: {
            listConversations: () => rows.map(agentSessionConversationView),
            getConversation: (id: string) => {
              const row = rows.find((candidate) => candidate.sessionId === id)
              return row ? agentSessionConversationView(row) : null
            }
          }
        },
        hasSession: () => false,
        getSessionTabId: () => null
      } as unknown as NonNullable<ReturnType<typeof sessionRegistry.getStructuredAgentSessionHost>>
      const installed = vi
        .spyOn(sessionRegistry, 'getStructuredAgentSessionHost')
        .mockReturnValue(host)
      const { promise: retirementStarted, resolve: started } = Promise.withResolvers<void>()
      const { promise: gate, resolve: release } = Promise.withResolvers<void>()
      runtime.delayRetirement(gate, started)
      let live = true
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this provider only supplies inventory and a successful fenced stop without an exit event.
      const provider = {
        listProcesses: async () =>
          live ? [{ id: PTY, worktreeId: WORKTREE, incarnationId: FIRST, cwd: '', title: '' }] : [],
        supportsFencedTermination: () => true,
        killFenced: async () => {
          live = false
          return { outcome: 'ended' }
        }
      } as unknown as IPtyProvider
      const exit = vi.spyOn(runtime, 'onPtyExit')
      const clear = vi.fn()
      let settled = false
      try {
        const pending = killAllProcessesForWorktrees([target], {
          runtime,
          localProvider: provider,
          onPtyStopped: clear
        }).then((outcomes) => {
          settled = true
          return outcomes
        })
        await retirementStarted
        expect(settled).toBe(false)
        expect(clear).not.toHaveBeenCalled()
        if (lateMember) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the final reader uses only conversation identity, location and detached owner state.
          rows.push({
            sessionId: 'late-chat',
            provider: 'claude',
            location: {
              workspaceId: WORKTREE,
              executionHostId: 'local',
              workspaceKind: 'folder',
              wslDistro: null
            },
            lease: { claimStatus: 'released', deathEvidence: null }
          } as AgentSessionRecord)
        }
        release()
        expect((await pending).get(worktreeRemovalTargetKey(target))).toBe(!lateMember)
        expect(exit).toHaveBeenCalledOnce()
        expect(clear).toHaveBeenCalledExactlyOnceWith(PTY)
      } finally {
        release()
        installed.mockRestore()
      }
    }
  )

  it.each([10, 257])(
    'joins captured real exit retirement after %i orphan exits without replay',
    async (count) => {
      const runtime = new ExitAuthorityRuntime()
      graph(runtime, null)
      const target = { worktreeId: WORKTREE, connectionId: null }
      const processes = new Map(
        Array.from({ length: count }, (_, index) => {
          const id = `${WORKTREE}@@orphan-${index}`
          return [
            id,
            { id, worktreeId: WORKTREE, incarnationId: `inc-${index}`, cwd: '', title: '' }
          ]
        })
      )
      const exit = vi.spyOn(runtime, 'onPtyExit')
      const stopped = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only process listing and shutdown are used by the real provider sweep.
      const provider = {
        listProcesses: async () => [...processes.values()],
        shutdown: async (id: string) => {
          const process = processes.get(id)!
          processes.delete(id)
          await runtime.onPtyExit(id, 0, process.incarnationId, { providerExitObserved: true })
        }
      } as unknown as IPtyProvider

      const outcomes = await killAllProcessesForWorktrees([target], {
        runtime,
        localProvider: provider,
        onPtyStopped: stopped
      })

      expect(outcomes.get(worktreeRemovalTargetKey(target))).toBe(true)
      expect(processes.size).toBe(0)
      expect(exit).toHaveBeenCalledTimes(count)
      expect(stopped).toHaveBeenCalledTimes(count)
      expect(runtime.verdictCount).toBeLessThanOrEqual(256)
    }
  )

  it('joins in-flight durable exit retirement without entering the lifecycle again', async () => {
    const runtime = new ExitAuthorityRuntime()
    graph(runtime, PTY, 1)
    register(runtime)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    runtime.delayRetirement(gate)
    const exit = vi.spyOn(runtime, 'onPtyExit')
    const retirement = runtime.onPtyExit(PTY, 0, FIRST, { hostExitConfirmed: true })
    let completed = false
    const joined = runtime.waitForPtyExitRetirement(PTY, FIRST).then((result) => {
      completed = true
      return result
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(exit).toHaveBeenCalledOnce()
    release()
    expect(await joined).toBe(true)
    await retirement
    expect(await runtime.waitForPtyExitRetirement(PTY, FIRST)).toBe(true)
    expect(exit).toHaveBeenCalledOnce()
  })

  it('keeps exact-stop history addressable through a changed snapshot before binding clears', async () => {
    const runtime = new ExitAuthorityRuntime()
    const git = {
      path: '/tmp/graph-exit',
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: false
    }
    const worktree = {
      ...git,
      git,
      id: WORKTREE,
      repoId: 'repo',
      displayName: 'graph-exit',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }
    const resolve = vi.spyOn(runtime, 'resolveGitWorktreeSelector').mockResolvedValue(worktree)
    const map = vi
      .spyOn(runtime, 'getResolvedWorktreeMap')
      .mockResolvedValue(new Map([[WORKTREE, worktree]]))
    let stopped = false
    let finishStop!: () => void
    const gate = new Promise<void>((done) => {
      finishStop = done
    })
    const stop = vi.fn(async () => {
      runtime.onPtyExit(PTY, 0, FIRST, { providerExitObserved: true })
      stopped = true
      await gate
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait: stop,
      getForegroundProcess: async () => null,
      hasPty: () => !stopped,
      listProcesses: async () =>
        stopped ? [] : [{ id: PTY, incarnationId: FIRST, cwd: worktree.path, title: 'terminal' }]
    })
    let pending: Promise<unknown> | undefined
    try {
      register(runtime)
      graph(runtime, PTY, 1)
      pending = runtime.stopExactTerminalsForWorktree(`id:${WORKTREE}`, [PTY], {
        keepHistory: true,
        targetOnly: true
      })
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
      graph(runtime, PTY, 2)
      expect(runtime.history()).toEqual({
        surfaces: 1,
        leaves: [{ connected: false, writable: false }],
        model: false
      })
      finishStop()
      await expect(pending).resolves.toMatchObject({ postStopVerified: true })
      graph(runtime, null, 3)
      expect(runtime.history().surfaces).toBe(1)
    } finally {
      finishStop()
      await pending
      resolve.mockRestore()
      map.mockRestore()
      runtime.onPtyExit(PTY, 0, FIRST)
    }
  })

  it('admits a registered successor and ignores the predecessor exit', () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    register(runtime, NEXT)
    runtime.onPtyExit(PTY, 0, FIRST)
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)).toBeNull()
  })

  it('admits a same-ID spawn before its registration commits', () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    runtime.onPtySpawned(PTY, NEXT)
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)).toBeNull()
  })

  it('allows owning inventory to prove the same ID live again', async () => {
    const runtime = new ExitAuthorityRuntime()
    register(runtime)
    runtime.onPtyExit(PTY, 0, FIRST)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: PTY, incarnationId: NEXT, cwd: '', title: 'terminal' }]
    })
    await runtime.listTerminals()
    graph(runtime)
    expect(runtime.capture()).toEqual({ connected: true, incarnationId: NEXT })
    expect(runtime.getPtyLivenessVerdict(PTY)?.status).toBe('live')
  })
})
