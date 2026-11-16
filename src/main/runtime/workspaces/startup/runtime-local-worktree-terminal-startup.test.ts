import { afterEach, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import { SetupTerminalCompletions } from '../../terminal/wait/setup-terminal-completions'
import { pasteWorktreeStartupDraftWhenReady } from './runtime-worktree-startup-readiness'

afterEach(() => vi.useRealTimers())

it('pastes the linked draft after slow required Setup and the agent composer become ready', async () => {
  vi.useFakeTimers()
  const setup = Promise.withResolvers<{ exitCode: number | null }>()
  const writes: string[] = []
  let emit = (_data: string): void => {}
  const started = await startRuntimeLocalWorktreeTerminals({
    request: { activate: false },
    repo: { id: 'repo' },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this startup seam reads only the workspace id and path.
    worktree: { id: 'repo::/task', path: '/task' } as Worktree,
    startup: { command: 'codex' },
    setup: { runnerScriptPath: '/task/setup.sh', envVars: {}, waitForAgentStartup: true },
    createdWithAgent: 'codex',
    draftPaste: { agent: 'codex', content: 'Repair the linked issue' },
    ports: {
      canSpawn: true,
      createTerminal: async () => ({ handle: 'agent', worktreeId: 'repo::/task', title: 'Codex' }),
      provision: async () => ({ setupSpawned: true, setupTerminalHandle: 'setup' }),
      waitForSetupTerminalCompletion: () => setup.promise,
      pasteDraft: (handle, draft) =>
        pasteWorktreeStartupDraftWhenReady(
          {
            getPtyId: () => 'agent-pty',
            getForegroundProcess: async () => 'codex',
            readRecentOutput: () => undefined,
            subscribeToData: (_ptyId, listener) => {
              emit = listener
              return () => {}
            },
            write: (_ptyId, data) => {
              writes.push(data)
            }
          },
          handle,
          draft
        ),
      sendFollowup: () => {},
      activate: () => {}
    }
  })
  expect(started.startupTerminalHandle).toBe('agent')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(writes).toEqual([])
  setup.resolve({ exitCode: 0 })
  await vi.advanceTimersByTimeAsync(0)
  emit('\x1b[?2004h\x1b[?25h› ')
  await vi.advanceTimersByTimeAsync(1500)
  expect(writes).toEqual(['\x1b[200~Repair the linked issue\x1b[201~'])
})

it.each([true, false])(
  'settles required in-process Setup from the hook result: %s',
  async (success) => {
    const hook = Promise.withResolvers<boolean>()
    const completion = new SetupTerminalCompletions()
    await startRuntimeLocalWorktreeTerminals({
      request: { activate: false, promisedAgentChat: true },
      repo: { id: 'repo' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup reads only the workspace id and path in this headless case.
      worktree: { id: 'repo::/task', path: '/task' } as Worktree,
      requiredSetup: true,
      inProcessSetup: hook.promise,
      ports: {
        canSpawn: false,
        setupPrepared: (id, required) => completion.preparedWorkspace(id, required),
        setupFailed: (id) => completion.refuseWorkspace(id),
        waitForSetupTerminalCompletion: async () => ({ exitCode: null }),
        createTerminal: async () => {
          throw new Error('No terminal controller')
        },
        provision: async () => {
          throw new Error('No terminal controller')
        },
        pasteDraft() {},
        sendFollowup() {},
        activate() {}
      }
    })
    hook.resolve(success)
    await expect(completion.forWorkspace('repo::/task')).resolves.toEqual({
      exitCode: success ? 0 : null
    })
  }
)
