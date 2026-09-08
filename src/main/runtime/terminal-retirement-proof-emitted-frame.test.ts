import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')

const retired = {
  parentTabId: 'tab',
  leafId: 'leaf',
  ptyId: 'pty',
  terminal: 'term_old',
  incarnationId: 'inc'
}

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  storeMobileSessionSnapshot: (
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ) => RuntimeMobileSessionTabsSnapshot
}

function seedRuntimeWithStoredProof(): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  internals: RuntimeInternals
} {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-runtime-fallback' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'headless:active-generation',
        snapshotVersion: 7,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
  const internals = runtime as unknown as RuntimeInternals
  const stored = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!
  internals.storeMobileSessionSnapshot(TEST_WORKTREE_ID, {
    ...stored,
    snapshotVersion: stored.snapshotVersion + 1,
    retiredTerminalSurfaces: [retired]
  })
  return { runtime, internals }
}

// Why: subscribers dedupe on (epoch, version), so a frame emitted at the stored version but
// built from the pre-store object would strand the proofs until an unrelated later bump.
it('emits the stored retirement proofs on the frame a runtime-owned create publishes', async () => {
  const { runtime, internals } = seedRuntimeWithStoredProof()
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged(
    (frame) => events.push(frame),
    'paired-client'
  )

  try {
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      navigation: 'caller',
      clientNavigationId: 'paired-client'
    })

    const storedAfter = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!
    const emitted = events.at(-1)!
    expect(storedAfter.retiredTerminalSurfaces).toEqual([retired])
    expect(emitted.snapshotVersion).toBe(storedAfter.snapshotVersion)
    expect(emitted.retiredTerminalSurfaces).toEqual([retired])
  } finally {
    unsubscribe()
  }
})
