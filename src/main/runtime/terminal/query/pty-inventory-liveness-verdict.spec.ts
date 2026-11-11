import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

export function registerPtyInventoryLivenessVerdictTests(): void {
  // Aggregate inventory may omit a disconnected relay; only its owner's evidence can distinguish exit from lost contact.

  const WORKTREE_ID = 'repo-1::/tmp/inventory-verdict'
  const REMOTE_PTY_ID = 'ssh:conn-1@@relay-9'

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
      resolve = settle
    })
    return { promise, resolve }
  }

  function makeStore() {
    let session = getDefaultWorkspaceSession()
    return {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next: typeof session) => {
        session = next
      }),
      getRepos: vi.fn(() => [
        {
          id: 'repo-1',
          path: '/tmp/inventory-verdict',
          displayName: 'inventory-verdict',
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

  function makeRuntimeMissingFromInventory(
    hasPty: () => boolean | null,
    listProcesses: () => Promise<{ id: string; worktreeId: string }[]> = vi.fn(async () => [])
  ): OrcaRuntimeService {
    // SAFETY: This partial store supplies the reads and writes used by inventory and liveness tracking.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      hasPty,
      listProcesses,
      getForegroundProcess: async () => null
      // SAFETY: Inventory and liveness tracking use only the controller methods supplied here.
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(REMOTE_PTY_ID, WORKTREE_ID, 'conn-1')
    return runtime
  }

  describe('inventory sweep liveness verdicts', () => {
    it('does not let a pre-drop inventory clear a newer lost-contact verdict', async () => {
      const inventory = deferred<{ id: string; worktreeId: string }[]>()
      const listProcesses = vi.fn(() => inventory.promise)
      const runtime = makeRuntimeMissingFromInventory(() => null, listProcesses)

      const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
      runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'relay disconnected during stop')
      inventory.resolve([{ id: REMOTE_PTY_ID, worktreeId: WORKTREE_ID }])
      await listing

      expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
        status: 'unverifiable',
        reason: 'relay disconnected during stop'
      })
    })

    it('does not let a partial inventory overwrite a concurrent provider failure', async () => {
      const inventory = deferred<{ id: string; worktreeId: string }[]>()
      const listProcesses = vi.fn(() => inventory.promise)
      const runtime = makeRuntimeMissingFromInventory(() => false, listProcesses)

      const listing = runtime.listTerminals(`id:${WORKTREE_ID}`)
      await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
      runtime.markPtyLivenessUnverifiable(REMOTE_PTY_ID, 'inventory transport failed')
      inventory.resolve([])
      await listing

      expect(runtime.getPtyLivenessVerdict(REMOTE_PTY_ID)).toEqual({
        status: 'unverifiable',
        reason: 'inventory transport failed'
      })
    })
  })
}
