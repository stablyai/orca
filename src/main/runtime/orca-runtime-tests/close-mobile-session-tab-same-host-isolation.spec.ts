import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RestoredOrchestrationAuthorityReceipt } from '../runtime-terminal-contracts'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

const siblingWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
const idleLeafId = HEADLESS_SECOND_LEAF_ID

for (const connectionId of [null, 'ssh-1']) {
  const host = connectionId ?? 'local'
  const ptyId = (name: string): string => (connectionId ? `ssh:${connectionId}@@${name}` : name)

  describe(`closing one mobile session on the ${host} host`, () => {
    it('leaves both working and idle sibling PTYs, owners, and tabs unchanged', async () => {
      const targetPtyId = ptyId('target')
      const workingPtyId = ptyId('sibling-working')
      const idlePtyId = ptyId('sibling-idle')
      const siblingTabs = [
        {
          id: 'sibling-working-tab',
          ptyId: workingPtyId,
          worktreeId: siblingWorktreeId,
          title: 'Working agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: 'sibling-idle-tab',
          ptyId: idlePtyId,
          worktreeId: siblingWorktreeId,
          title: 'Idle agent',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
      const session = makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: targetPtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Target',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ],
          [siblingWorktreeId]: siblingTabs
        },
        terminalLayoutsByTabId: {
          'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: targetPtyId }),
          'sibling-working-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: workingPtyId }),
          'sibling-idle-tab': makeHeadlessTerminalLayout({ [idleLeafId]: idlePtyId })
        }
      })
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        session,
        connectionId ? `ssh:${connectionId}` : 'local'
      )
      const remoteRepo = connectionId ? { ...store.getRepo(TEST_REPO_ID)!, connectionId } : null
      const runtime = new OrcaRuntimeService(
        (connectionId
          ? {
              ...runtimeStore,
              getRepos: () => [remoteRepo!],
              getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
            }
          : runtimeStore) as never
      )
      const kill = vi.fn(() => false)
      const stopAndWait = vi.fn(async (id: string) => {
        runtime.onPtyExit(id, 0)
        return true
      })
      const listProcesses = vi.fn(async () => [
        { id: targetPtyId, cwd: TEST_WORKTREE_PATH, title: 'Target', worktreeId: TEST_WORKTREE_ID },
        // A stale provider projection must not replace a sibling's existing owners or title.
        {
          id: workingPtyId,
          cwd: '/tmp/worktree-b',
          title: 'Stale title',
          worktreeId: siblingWorktreeId,
          incarnationId: 'new-incarnation',
          agentSessionOwners: []
        }
        // The idle sibling is omitted despite still existing in the host's session state.
      ])
      const hostIds: ExecutionHostId[] = [LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId('ssh-1')]
      const listProcessesWithHostScope = vi.fn(async () => ({
        processes: await listProcesses(),
        hostIds
      }))
      runtime.setPtyController({
        write: () => true,
        kill,
        stopAndWait,
        listProcesses,
        listProcessesWithHostScope,
        hasPty: (id: string) => id === targetPtyId || id === workingPtyId,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      runtime.registerPty(targetPtyId, TEST_WORKTREE_ID, connectionId, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      for (const [id, tabId, leafId] of [
        [workingPtyId, 'sibling-working-tab', HEADLESS_LEAF_ID],
        [idlePtyId, 'sibling-idle-tab', idleLeafId]
      ]) {
        runtime.registerPty(id, siblingWorktreeId, connectionId, { tabId, leafId })
        const record = runtime['ptysById'].get(id)!
        record.agentSessionOwners = [
          {
            claim: {
              digestVersion: 1,
              keyId: 'key',
              identityDigest: 'identity',
              worktreeScopeDigest: 'scope',
              agent: 'claude'
            },
            generation: 'generation',
            phase: 'live',
            ptyId: id,
            surface: {
              worktreeId: siblingWorktreeId,
              tabId,
              leafId,
              terminalHandle: `term-${tabId}`
            }
          }
        ]
        record.controllerTitle = 'Original title'
      }
      const siblingReceipt: RestoredOrchestrationAuthorityReceipt = {
        ptyId: idlePtyId,
        worktreeId: siblingWorktreeId,
        terminalHandle: 'term-sibling-idle-tab',
        paneKey: 'sibling-idle-tab:idle',
        processIncarnation: `${idlePtyId}:incarnation`,
        hostScope: connectionId
          ? { kind: 'ssh' as const, targetId: connectionId }
          : { kind: 'local' as const, hostId: LOCAL_EXECUTION_HOST_ID }
      }
      runtime['restoredOrchestrationAuthorityByPtyId'].set(idlePtyId, siblingReceipt)
      runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](siblingWorktreeId)
      const beforeRecords = [workingPtyId, idlePtyId].map((id) =>
        structuredClone(runtime['ptysById'].get(id))
      )
      const beforeTabs = structuredClone(
        runtime['mobileSessionTabsByWorktree'].get(siblingWorktreeId)
      )
      const beforePersistedTabs = structuredClone(getSession().tabsByWorktree[siblingWorktreeId])

      await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

      expect([workingPtyId, idlePtyId].map((id) => runtime['ptysById'].get(id))).toEqual(
        beforeRecords
      )
      expect(runtime['restoredOrchestrationAuthorityByPtyId'].get(idlePtyId)).toEqual(
        siblingReceipt
      )
      expect(runtime['mobileSessionTabsByWorktree'].get(siblingWorktreeId)).toEqual(beforeTabs)
      expect(getSession().tabsByWorktree[siblingWorktreeId]).toEqual(beforePersistedTabs)
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
      expect(kill).toHaveBeenCalledWith(targetPtyId)
      expect(kill).not.toHaveBeenCalledWith(workingPtyId)
      expect(kill).not.toHaveBeenCalledWith(idlePtyId)
      expect(listProcessesWithHostScope).not.toHaveBeenCalled()
    })

    it('retires only a target receipt when its PTY is reassigned to a sibling workspace', async () => {
      const movedPtyId = ptyId('moved-to-sibling')
      const siblingPtyId = ptyId('untouched-sibling')
      const remoteRepo = connectionId ? { ...store.getRepo(TEST_REPO_ID)!, connectionId } : null
      const runtime = new OrcaRuntimeService(
        (remoteRepo
          ? {
              ...store,
              getRepos: () => [remoteRepo],
              getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
            }
          : store) as never
      )
      const hostScope: RestoredOrchestrationAuthorityReceipt['hostScope'] = connectionId
        ? { kind: 'ssh', targetId: connectionId }
        : { kind: 'local', hostId: LOCAL_EXECUTION_HOST_ID }
      const targetReceipt: RestoredOrchestrationAuthorityReceipt = {
        ptyId: movedPtyId,
        worktreeId: TEST_WORKTREE_ID,
        terminalHandle: 'old-handle',
        paneKey: 'old-tab:leaf',
        processIncarnation: 'old-incarnation',
        hostScope
      }
      const siblingReceipt: RestoredOrchestrationAuthorityReceipt = {
        ...targetReceipt,
        ptyId: siblingPtyId,
        worktreeId: siblingWorktreeId,
        terminalHandle: 'sibling-handle'
      }
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        listProcesses: async () => [
          {
            id: movedPtyId,
            cwd: '/tmp/worktree-b',
            title: 'Moved terminal',
            worktreeId: siblingWorktreeId,
            incarnationId: 'new-incarnation',
            agentSessionOwners: []
          }
        ],
        hasPty: () => true,
        getForegroundProcess: async () => null
      })
      runtime.registerPty(movedPtyId, TEST_WORKTREE_ID, connectionId)
      runtime.registerPty(siblingPtyId, siblingWorktreeId, connectionId)
      runtime['restoredOrchestrationAuthorityByPtyId'].set(movedPtyId, targetReceipt)
      runtime['restoredOrchestrationAuthorityByPtyId'].set(siblingPtyId, siblingReceipt)
      const siblingBefore = structuredClone(runtime['ptysById'].get(siblingPtyId))

      await runtime['refreshMobileSessionPtyRecords'](TEST_WORKTREE_ID)

      expect(runtime['restoredOrchestrationAuthorityByPtyId'].has(movedPtyId)).toBe(false)
      expect(runtime['restoredOrchestrationAuthorityByPtyId'].get(siblingPtyId)).toEqual(
        siblingReceipt
      )
      expect(runtime['ptysById'].get(siblingPtyId)).toEqual(siblingBefore)
    })

    it('still reconciles all workspaces in an explicitly global inventory', async () => {
      const workingPtyId = ptyId('global-working')
      const idlePtyId = ptyId('global-idle')
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        listProcesses: async () => [],
        listProcessesWithHostScope: async () => ({
          processes: [
            {
              id: workingPtyId,
              cwd: '/tmp/worktree-b',
              title: 'Observed title',
              worktreeId: siblingWorktreeId,
              incarnationId: 'observed-incarnation',
              agentSessionOwners: []
            }
          ],
          hostIds: [connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID]
        }),
        hasPty: () => false,
        getForegroundProcess: async () => null
      })
      runtime.registerPty(workingPtyId, siblingWorktreeId, connectionId)
      runtime.registerPty(idlePtyId, siblingWorktreeId, connectionId)
      runtime['ptysById'].get(workingPtyId)!.controllerTitle = 'Old title'

      await runtime['refreshMobileSessionPtyRecords']()

      expect(runtime['ptysById'].get(workingPtyId)).toMatchObject({
        controllerTitle: 'Observed title',
        incarnationId: 'observed-incarnation',
        connected: true
      })
      expect(runtime['ptysById'].get(idlePtyId)?.connected).toBe(false)
    })
  })
}

describe('closing a local session with a sibling on another host', () => {
  it('does not query or reconcile the unrelated SSH provider', async () => {
    const siblingPtyId = 'ssh:ssh-other@@sibling'
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'local-target',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Target',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'local-target' })
      }
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const hostIds: ExecutionHostId[] = [LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId('ssh-other')]
    const listProcessesWithHostScope = vi.fn(async () => ({
      processes: [],
      hostIds
    }))
    const kill = vi.fn(() => true)
    runtime.setPtyController({
      write: () => true,
      kill,
      listProcesses: async () => [
        {
          id: 'local-target',
          cwd: TEST_WORKTREE_PATH,
          title: 'Target',
          worktreeId: TEST_WORKTREE_ID
        }
      ],
      listProcessesWithHostScope,
      hasPty: () => false,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    runtime.registerPty('local-target', TEST_WORKTREE_ID)
    runtime.registerPty(siblingPtyId, siblingWorktreeId, 'ssh-other')
    const before = structuredClone(runtime['ptysById'].get(siblingPtyId))

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab')

    expect(listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(runtime['ptysById'].get(siblingPtyId)).toEqual(before)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(kill).not.toHaveBeenCalledWith(siblingPtyId)
  })
})
