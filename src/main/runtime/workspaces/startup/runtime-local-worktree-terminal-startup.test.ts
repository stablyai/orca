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
        setupPrepared: (id, required, inProcess) =>
          completion.preparedWorkspace(id, required, inProcess),
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

it.each(['replacement-success', 'replacement-failure', 'removal'] as const)(
  'ignores a late in-process result after workspace %s',
  async (change) => {
    const hook = Promise.withResolvers<boolean>()
    const completion = new SetupTerminalCompletions()
    await startRuntimeLocalWorktreeTerminals({
      request: { activate: false, promisedAgentChat: true },
      repo: { id: 'repo' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this headless startup reads only workspace id and path.
      worktree: { id: 'repo::/task', path: '/task' } as Worktree,
      requiredSetup: true,
      inProcessSetup: hook.promise,
      ports: {
        canSpawn: false,
        setupPrepared: (id, required, inProcess) =>
          completion.preparedWorkspace(id, required, inProcess),
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
    const original = completion.forWorkspace('repo::/task')
    const replacement = change.startsWith('replacement')
    if (replacement) {
      completion.bindRecipe('repo::/task', {
        runnerScriptPath: '/task/setup.sh',
        platform: 'posix',
        nonce: 'new-setup',
        deadline: Number.MAX_SAFE_INTEGER
      })
      completion.begin('new-setup-pty', 'new-handle', 'new-setup', 'repo::/task')
    }
    if (!replacement) {
      completion.forgetWorkspace('repo::/task')
    }
    let released = false
    void (replacement ? completion.forWorkspace('repo::/task') : undefined)?.then(() => {
      released = true
    })
    hook.resolve(change !== 'replacement-failure')
    await hook.promise
    await Promise.resolve()
    expect(released).toBe(false)
    if (replacement) {
      await expect(original).resolves.toEqual({
        exitCode: change === 'replacement-failure' ? null : 0
      })
      completion.observe('new-setup-pty', '__ORCA_SETUP_COMPLETE__:new-setup:0\n')
      await expect(completion.forWorkspace('repo::/task')).resolves.toEqual({ exitCode: 0 })
    } else {
      expect(completion.forWorkspace('repo::/task')).toBeUndefined()
    }
    completion.forgetWorkspace('repo::/task')
  }
)

it.each([0, 7])('keeps a captured writer result %i with its original recipe', async (exitCode) => {
  const completion = new SetupTerminalCompletions()
  const refuseOriginal = completion.bindRecipe('workspace', {
    runnerScriptPath: '/task/setup.sh',
    platform: 'posix',
    nonce: 'original',
    deadline: Number.MAX_SAFE_INTEGER
  })
  const original = completion.forWorkspace('workspace')
  const writer = completion.capture('workspace', 'original-handle', {
    setupCompletionToken: 'original',
    setupRequired: true,
    sessionId: 'original-pty'
  })
  completion.bindRecipe('workspace', {
    runnerScriptPath: '/task/setup.sh',
    platform: 'posix',
    nonce: 'replacement',
    deadline: Number.MAX_SAFE_INTEGER
  })
  let replacementFinished = false
  void completion.forWorkspace('workspace')?.then(() => {
    replacementFinished = true
  })
  writer?.begin()
  completion.observe('original-pty', `__ORCA_SETUP_COMPLETE__:original:${exitCode}\n`)
  writer?.finish(true)
  await expect(original).resolves.toEqual({ exitCode })
  refuseOriginal()
  await Promise.resolve()
  expect(replacementFinished).toBe(false)
  completion.forgetWorkspace('workspace')
})

it('keeps a surviving same-nonce writer when another capture is abandoned', async () => {
  const completion = new SetupTerminalCompletions()
  completion.bindRecipe('workspace', {
    runnerScriptPath: '/task/setup.sh',
    platform: 'posix',
    nonce: 'same',
    deadline: Number.MAX_SAFE_INTEGER
  })
  const abandoned = completion.capture('workspace', 'unused', {
    setupCompletionToken: 'same',
    setupRequired: true,
    sessionId: 'unused-pty'
  })
  const survivor = completion.capture('workspace', 'live', {
    setupCompletionToken: 'same',
    setupRequired: true,
    sessionId: 'live-pty'
  })
  survivor?.begin()
  abandoned?.finish(false)
  completion.observe('live-pty', '__ORCA_SETUP_COMPLETE__:same:0\n')
  survivor?.finish(true)
  await expect(completion.forWorkspace('workspace')).resolves.toEqual({ exitCode: 0 })
  completion.forgetWorkspace('workspace')
})
