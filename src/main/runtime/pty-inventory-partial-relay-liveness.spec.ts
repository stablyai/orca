import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

export function registerPtyInventoryPartialRelayLivenessTests(): void {
  // Budget liveness refresh so mobile observes exits; omitted PTYs with controller proof must survive (STA-517).
  const REPO_ID = 'repo-1'
  const REPO_PATH = '/tmp/relay-liveness'
  const WORKSPACE = `${REPO_ID}::${REPO_PATH}`
  const RETAINED_PTY = `${WORKSPACE}@@retained-pty`
  const TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const LEAF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

  // Mirrors the runtime's own list budget; the forwarded deadline has to land strictly inside it.
  const LIST_BUDGET_MS = 3000

  const REPO = {
    id: REPO_ID,
    path: REPO_PATH,
    displayName: 'relay-liveness',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git'
  } as const

  type RuntimeInternals = {
    buildResolvedWorktreeFromId: (worktreeId: string) => unknown
    refreshPtyWorktreeRecordsWithControllerInventory: (
      resolvedWorktrees: unknown[],
      targetWorktreeId?: string | null,
      deadline?: number
    ) => Promise<unknown>
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state?: Record<string, unknown>
    ) => Record<string, unknown>
    ptysById: Map<string, { connected: boolean }>
    restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
  }

  type ListCall = { connectionId: string | null | undefined; deadlineMs: number | undefined }

  function createRuntime(options: { sessions?: unknown[]; vouchesForRetainedPty?: boolean } = {}): {
    internals: RuntimeInternals
    calls: ListCall[]
  } {
    const meta: Record<string, Record<string, unknown>> = { [WORKSPACE]: { hostId: 'local' } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence and graph methods exercised by the test.
    const store = withDurableRuntimeStore({
      getRepos: () => [REPO],
      getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
      getAllWorktreeMeta: () => meta,
      getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, patch: Record<string, unknown>) => {
        meta[worktreeId] = { ...meta[worktreeId], ...patch }
        return meta[worktreeId]
      },
      getWorkspaceSession: () => getDefaultWorkspaceSession(),
      setWorkspaceSession: () => {},
      flushOrThrow: () => {}
    }) as never
    const calls: ListCall[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      // Why: the controller's own liveness vouch, which the runtime consults for a PTY the
      // listing omitted. A relay that failed to list still owns its panes.
      hasPty: (ptyId: string) =>
        options.vouchesForRetainedPty && ptyId === RETAINED_PTY ? true : null,
      listProcesses: async (connectionId?: string | null, opts?: { deadlineMs?: number }) => {
        calls.push({ connectionId, deadlineMs: opts?.deadlineMs })
        return options.sessions ?? []
      }
    } as never)
    return { internals: runtime as unknown as RuntimeInternals, calls }
  }

  describe('pty inventory refresh against a partially answering relay set', () => {
    it('gives the providers a deadline strictly inside its own list budget', async () => {
      const { internals, calls } = createRuntime()
      const before = Date.now()

      await internals.refreshPtyWorktreeRecordsWithControllerInventory([
        internals.buildResolvedWorktreeFromId(WORKSPACE)
      ])

      expect(calls).toHaveLength(1)
      const { deadlineMs } = calls[0]!
      // A default 30s SSH list exceeds the refresh budget, preventing any inventory retirement.
      expect(deadlineMs).toBeDefined()
      expect(deadlineMs!).toBeGreaterThan(before)
      expect(deadlineMs!).toBeLessThan(before + LIST_BUDGET_MS)
    })

    it('honours a caller deadline tighter than the list budget', async () => {
      const { internals, calls } = createRuntime()
      const callerDeadline = Date.now() + 400

      await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        [internals.buildResolvedWorktreeFromId(WORKSPACE)],
        null,
        callerDeadline
      )

      expect(calls[0]!.deadlineMs!).toBeLessThanOrEqual(callerDeadline)
    })

    it('keeps orchestration authority for a pane the controller still vouches for', async () => {
      const { internals } = createRuntime({ vouchesForRetainedPty: true })
      internals.recordPtyWorktree(RETAINED_PTY, WORKSPACE, {
        connected: true,
        tabId: TAB_ID,
        paneKey: PANE_KEY
      })
      internals.restoredOrchestrationAuthorityByPtyId.set(RETAINED_PTY, {
        ptyId: RETAINED_PTY,
        worktreeId: WORKSPACE,
        terminalHandle: 'term_retained',
        paneKey: PANE_KEY,
        processIncarnation: `${RETAINED_PTY}:inc-1`,
        hostScope: { kind: 'local' }
      })

      await internals.refreshPtyWorktreeRecordsWithControllerInventory([
        internals.buildResolvedWorktreeFromId(WORKSPACE)
      ])

      // Use the rescued live set to retain authority; a raw listing omission cannot prove exit.
      expect(internals.restoredOrchestrationAuthorityByPtyId.has(RETAINED_PTY)).toBe(true)
      expect(internals.ptysById.get(RETAINED_PTY)?.connected).toBe(true)
    })

    it('retires a pane no provider vouches for', async () => {
      const { internals } = createRuntime({ vouchesForRetainedPty: false })
      internals.recordPtyWorktree(RETAINED_PTY, WORKSPACE, {
        connected: true,
        tabId: TAB_ID,
        paneKey: PANE_KEY
      })
      internals.restoredOrchestrationAuthorityByPtyId.set(RETAINED_PTY, {
        ptyId: RETAINED_PTY,
        worktreeId: WORKSPACE,
        terminalHandle: 'term_retained',
        paneKey: PANE_KEY,
        processIncarnation: `${RETAINED_PTY}:inc-1`,
        hostScope: { kind: 'local' }
      })

      await internals.refreshPtyWorktreeRecordsWithControllerInventory([
        internals.buildResolvedWorktreeFromId(WORKSPACE)
      ])

      // Answered inventory without controller proof can clear mobile activity and restored authority.
      expect(internals.ptysById.get(RETAINED_PTY)?.connected).toBe(false)
      expect(internals.restoredOrchestrationAuthorityByPtyId.has(RETAINED_PTY)).toBe(false)
    })
  })
}
