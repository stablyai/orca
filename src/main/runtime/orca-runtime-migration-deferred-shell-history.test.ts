import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } from './orca-runtime-test-fixtures.spec'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
  buildResolvedWorktreeFromId: (worktreeId: string) => unknown
  getResolvedWorktreeMap: () => Promise<Map<string, unknown>>
}

function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members are declared on OrcaRuntimeService's inheritance chain.
  return runtime as unknown as RuntimeInternals
}

describe('a moved shell history that waited on live shells', () => {
  it('is retried when the last shell of its worktree exits, with the live-shell check', () => {
    const installDeferred = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installDeferredOrcadMigrationShellHistory: installDeferred
    })
    const internals = internalsOf(runtime)
    internals.recordPtyWorktree('pty-1', 'repo-1::/srv/app', { connected: true })
    internals.recordPtyWorktree('pty-2', 'repo-1::/srv/app', { connected: true })

    runtime.onPtyExit('pty-1', 0)
    const [worktreeId, options] = installDeferred.mock.calls[0]
    expect(worktreeId).toBe('repo-1::/srv/app')
    // pty-2 still runs there, so the store keeps waiting.
    expect(options.worktreeHasLiveShells('repo-1::/srv/app')).toBe(true)

    runtime.onPtyExit('pty-2', 0)
    expect(installDeferred.mock.calls[1][1].worktreeHasLiveShells('repo-1::/srv/app')).toBe(false)
  })

  it('is installed once the runtime attached, counting daemon shells that outlived a restart', async () => {
    const installPending = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installPendingOrcadMigrationReceivedBlobs: installPending,
      hasPendingOrcadMigrationShellHistory: () => true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: vi.fn(async () => [
        { id: 'daemon-pty', cwd: '/srv/app', title: 'zsh', worktreeId: 'repo-1::/srv/app' },
        // No provider owner: only the host's real worktrees can file this shell by its cwd.
        { id: 'unowned-pty', cwd: TEST_WORKTREE_PATH, title: 'zsh' }
      ])
    })
    const internals = internalsOf(runtime)
    vi.spyOn(internals, 'getResolvedWorktreeMap').mockResolvedValue(
      new Map([[TEST_WORKTREE_ID, internals.buildResolvedWorktreeFromId(TEST_WORKTREE_ID)]])
    )

    await runtime.installPendingOrcadMigrationShellHistory()

    const [options] = installPending.mock.calls[0]
    expect(options.worktreeHasLiveShells('repo-1::/srv/app')).toBe(true)
    expect(options.worktreeHasLiveShells(TEST_WORKTREE_ID)).toBe(true)
    expect(options.worktreeHasLiveShells('repo-1::/srv/other')).toBe(false)
  })

  it('waits when the terminal inventory does not answer', async () => {
    const installPending = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installPendingOrcadMigrationReceivedBlobs: installPending,
      hasPendingOrcadMigrationShellHistory: () => true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: vi.fn(async () => {
        throw new Error('daemon unreachable')
      })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runtime.installPendingOrcadMigrationShellHistory()

    expect(installPending).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('costs a start with nothing pending no inventory and keeps restored receipts', async () => {
    const installPending = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      installPendingOrcadMigrationReceivedBlobs: installPending,
      hasPendingOrcadMigrationShellHistory: () => false
    })
    const listProcesses = vi.fn(async () => [{ id: 'daemon-pty', cwd: '/elsewhere', title: 'zsh' }])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const receipt = {
      ptyId: 'daemon-pty',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term_daemon',
      paneKey: 'tab-1:1',
      processIncarnation: 'daemon-pty:inc-1',
      hostScope: { kind: 'local' }
    }
    internalsOf(runtime).restoredOrchestrationAuthorityByPtyId.set('daemon-pty', receipt)

    await runtime.installPendingOrcadMigrationShellHistory()

    expect(listProcesses).not.toHaveBeenCalled()
    expect(installPending).not.toHaveBeenCalled()
    expect(internalsOf(runtime).restoredOrchestrationAuthorityByPtyId.get('daemon-pty')).toBe(
      receipt
    )
  })
})
