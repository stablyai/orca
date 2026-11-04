import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'

// Preserve side-effect order: mocks, lifecycle, fixtures.
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

// Layout binds panes in the runtime store's session, so isolate the shared fixture.
function makeRuntime(
  runtimeStore: ConstructorParameters<typeof OrcaRuntimeService>[0] = { ...store },
  sshTargetId?: string
) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-resume' })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
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

// #10923: phone history types resume into a plain shell; host launch cannot infer the conversation.
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
        launchedAt: 0
      })
    )
    // Typed resume owns Codex home; spawn receives no provider session.
    expect(spawn.mock.calls[0]?.[0]?.resumeProviderSession).toBeUndefined()

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
