import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, TEST_WORKTREE_ID, store } = await import('./orca-runtime-test-fixtures.spec')
const { bindPaneFirst, committingSpawn } = await import('./bind-first-pane.test-fixture')
const { toSshExecutionHostId } = await import('../../shared/execution-host')

const SESSION = { key: 'session_id', id: 'codex-history-session' } as const

let restoreRecord: (() => void) | undefined
function spyOnRecord() {
  const spy = vi.spyOn(agentHookServer, 'recordLaunchResumeIdentity')
  restoreRecord = () => spy.mockRestore()
  return spy
}

// Why a copy of the shared store: main's layout binds panes in the runtime store's session.
function makeRuntime(
  runtimeStore: ConstructorParameters<typeof OrcaRuntimeService>[0] = { ...store },
  sshTargetId?: string
) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-resume' })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    // An SSH pane's binding lives in its execution host's session.
    spawn: sshTargetId
      ? async (args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
          const result = await spawn(args)
          if (args.worktreeId && args.tabId && args.leafId) {
            bindPaneFirst(
              runtime,
              {
                worktreeId: args.worktreeId,
                tabId: args.tabId,
                leafId: args.leafId,
                ptyId: result.id
              },
              toSshExecutionHostId(sshTargetId)
            )
          }
          return result
        }
      : committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

// #10923: the phone's Session History types the resume into a fresh shell pane, so the host
// spawns no agent and cannot learn the conversation from the launch.
describe('a phone resume from Session History', () => {
  afterEach(() => {
    restoreRecord?.()
  })

  it('records the conversation it names as the pane identity', async () => {
    const record = spyOnRecord()
    const { runtime, spawn } = makeRuntime()

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      launchAgent: 'codex',
      resumeProviderSession: SESSION,
      clientNavigationId: 'phone-1',
      clientMutationId: 'resume-1'
    })

    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: `${created.tab.parentTabId}:${created.tab.leafId}`,
        worktreeId: TEST_WORKTREE_ID,
        agentType: 'codex',
        providerSession: SESSION,
        // Every row on this pane is the agent's own, so the seed never replaces one.
        launchedAt: 0
      })
    )
    // The shell is spawned plainly: the phone's typed command owns the Codex home.
    expect(spawn.mock.calls[0]?.[0]?.resumeProviderSession).toBeUndefined()

    // A retried create gets the same pane and must not re-seed over the agent's own report.
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      launchAgent: 'codex',
      resumeProviderSession: SESSION,
      clientNavigationId: 'phone-1',
      clientMutationId: 'resume-1'
    })
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('records nothing for a create that names no conversation', async () => {
    const record = spyOnRecord()
    const { runtime } = makeRuntime()

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { launchAgent: 'codex' })

    expect(record).not.toHaveBeenCalled()
  })

  it('leaves an SSH pane to the relay that owns its status', async () => {
    const record = spyOnRecord()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const { runtime } = makeRuntime(
      {
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
      },
      'ssh-1'
    )

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      launchAgent: 'codex',
      resumeProviderSession: SESSION
    })

    expect(record).not.toHaveBeenCalled()
  })
})
