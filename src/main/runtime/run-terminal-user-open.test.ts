// Finished-run cleanup must keep a run terminal a client opened after its process started.
import { describe, expect, it, vi } from 'vitest'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('./orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('./orca-runtime')
await import('./orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-tests/orca-runtime-test-fixtures.spec')

describe('run terminal client use after a tab open', () => {
  it('reads a freshly spawned terminal as used once a user opens its tab, not on a probe', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'run-pty' }),
      write: () => true,
      kill: () => false,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const activate = (intent: 'user' | 'automatic') =>
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
        notifyClients: false,
        navigation: 'caller',
        intent
      })

    await activate('automatic')
    // What main's spawn commit records for a process it started.
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'run-pty' })
    expect(runtime.readTerminalClientUse('run-pty')).toBe('unused')

    await activate('automatic')
    expect(runtime.readTerminalClientUse('run-pty')).toBe('unused')

    await activate('user')
    expect(runtime.readTerminalClientUse('run-pty')).toBe('used')
  })

  it('keeps the open mark on the process a user open starts', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      // What main's spawn path does before the spawn returns.
      spawn: vi.fn(async () => {
        runtime.terminalRunFacts.recordSpawnCommit({ id: 'run-pty' })
        return { id: 'run-pty' }
      }),
      write: () => true,
      kill: () => false,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
    expect(runtime.readTerminalClientUse('run-pty')).toBe('used')
  })
})
