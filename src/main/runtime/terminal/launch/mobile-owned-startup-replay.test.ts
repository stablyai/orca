import { expect, it, vi } from 'vitest'

await import('../../construction/test-context/runtime-test-module-registration.spec')
await import('../../construction/test-context/orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const { store, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('../../construction/test-context/orca-runtime-test-fixtures.spec')
const { bindPaneFirst } = await import('../layout/bind-first-pane.test-fixture')

it.each(['codex', 'claude'] as const)(
  'reconciles an accepted %s startup after its reply is lost without delivering the command again',
  async (agent) => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService({ ...store })
      await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      const commands: string[] = []
      const live: {
        id: string
        cwd: string
        title: string
        worktreeId: string
        terminalHandle: string
      }[] = []
      runtime.setPtyController({
        spawn: async (args: {
          command?: string
          preAllocatedHandle?: string
          worktreeId?: string
          tabId?: string
          leafId?: string
        }) => {
          if (args.command) {
            commands.push(args.command)
          }
          live.push({
            id: 'accepted-startup',
            cwd: TEST_WORKTREE_PATH,
            title: agent,
            worktreeId: TEST_WORKTREE_ID,
            terminalHandle: args.preAllocatedHandle ?? ''
          })
          if (args.worktreeId && args.tabId && args.leafId) {
            bindPaneFirst(runtime, {
              worktreeId: args.worktreeId,
              tabId: args.tabId,
              leafId: args.leafId,
              ptyId: 'accepted-startup'
            })
          }
          throw new Error('client_disconnected')
        },
        listProcesses: async () => live,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const request = {
        command: `${agent} --resume source`,
        requireOwnedStartup: true as const,
        launchAgent: agent,
        activate: false,
        select: false,
        navigation: 'caller' as const,
        clientNavigationId: 'phone',
        clientMutationId: 'resume-operation'
      }
      await expect(
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, request)
      ).rejects.toThrow('client_disconnected')
      await vi.advanceTimersByTimeAsync(61_000)
      const retry = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, request)
      expect(commands).toEqual([`${agent} --resume source`])
      expect(retry.tab).toMatchObject({ ptyId: 'accepted-startup', launchAgent: agent })
    } finally {
      vi.useRealTimers()
    }
  }
)
