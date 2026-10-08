import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

const CONNECTION_ID = 'conn-relay'
const REATTACHED_PTY_ID = `ssh:${CONNECTION_ID}@@pty-1`
const INCARNATION_ID = 'relay-incarnation-1'

// A relay lease from an earlier app launch, reattached by this one, then closed from the CLI.
function makeReattachedRelayRuntime(): OrcaRuntimeService {
  const session = makeWorkspaceSessionWithHeadlessTerminal({
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'host-tab',
          ptyId: REATTACHED_PTY_ID,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Relay Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: REATTACHED_PTY_ID })
    }
  })
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  const repo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: CONNECTION_ID }
  runtimeStore.getRepos = () => [repo]
  runtimeStore.getRepo = (id: string) => (id === TEST_REPO_ID ? repo : undefined)
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return runtime
}

function reattach(runtime: OrcaRuntimeService): void {
  runtime.registerPty(REATTACHED_PTY_ID, TEST_WORKTREE_ID, CONNECTION_ID, {
    tabId: 'host-tab',
    leafId: HEADLESS_LEAF_ID,
    incarnationId: INCARNATION_ID
  })
}

describe('closing a workspace whose relay terminal was reattached from an earlier launch', () => {
  it('reports the host-confirmed exit instead of doubting the retained SSH record', async () => {
    const runtime = makeReattachedRelayRuntime()
    reattach(runtime)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async (ptyId: string) => {
        runtime.onPtyExit(ptyId, 0, INCARNATION_ID)
        return true
      }),
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.closeTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.not.toHaveProperty('ptyStopVerdict')
    expect(runtime.getPtyLivenessVerdict(REATTACHED_PTY_ID)).toEqual({ status: 'exited' })
  })

  it('accepts the host exit even when the stop confirmation carries no incarnation', async () => {
    const runtime = makeReattachedRelayRuntime()
    reattach(runtime)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async (ptyId: string) => {
        // Field shape: the reattached relay exit arrives with code 1 and no incarnation.
        runtime.onPtyExit(ptyId, 1, undefined, { hostExitConfirmed: true })
        return true
      }),
      getForegroundProcess: async () => null
    })

    await expect(runtime.closeTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)).resolves.toEqual(
      expect.not.objectContaining({ ptyStopVerdict: expect.anything() })
    )
    expect(runtime.getPtyLivenessVerdict(REATTACHED_PTY_ID)).toEqual({ status: 'exited' })
  })

  it('keeps the exit when the reattach registration lands after the stop', async () => {
    const runtime = makeReattachedRelayRuntime()
    reattach(runtime)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async (ptyId: string) => {
        runtime.onPtyExit(ptyId, 0, INCARNATION_ID)
        // The reattach that proved this incarnation alive finishes registering only now.
        reattach(runtime)
        return true
      }),
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.closeTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.not.toHaveProperty('ptyStopVerdict')
    expect(runtime.getPtyLivenessVerdict(REATTACHED_PTY_ID)).toEqual({ status: 'exited' })
  })

  it('still doubts a retained SSH record whose exit was never confirmed', async () => {
    const runtime = makeReattachedRelayRuntime()
    reattach(runtime)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => false),
      stopAndWait: vi.fn(async () => false),
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.closeTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({
      stopped: 0,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'the owning host did not confirm the PTY exit'
    })
  })
})
