import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultRepoHookSettings, getDefaultSettings } from '../../../../shared/constants'
import { createProjectGroup } from '../../../../shared/project-groups'
import { prepareGroupFolderCreation } from './runtime-group-folder-setup'
import { OrcaRuntimeWithGroupFolderSetup } from './runtime-group-folder-setup-host'
import { provisionWorktreeTerminals } from '../startup/runtime-worktree-terminal-provisioning'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from '../../terminal/wait/terminal-wait-visible-probe'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../startup/workspace-terminal-provisioning', () => ({
  OrcaRuntimeWithGetWorktreeTerminalProvisioningHost: class {}
}))
vi.mock('../../terminal/input/terminal-agent-prompt-render', () => ({
  OrcaRuntimeWithCreateAgentPromptRenderGate: class {}
}))
const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(
  fast = false,
  unprovableHost = false,
  delivery: 'draft' | 'auto-submit' = 'draft'
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-group-pending-input-')))
  roots.push(root)
  const group = {
    ...createProjectGroup({
      name: 'Services',
      parentPath: root,
      createdFrom: 'folder-scan',
      tabOrder: 0
    }),
    hookSettings: {
      ...getDefaultRepoHookSettings(),
      scripts: { setup: 'echo setup', archive: '' },
      setupAgentStartupPolicy: 'wait-for-setup' as const,
      commandSourcePolicy: 'local-only' as const
    }
  }
  const workspace: FolderWorkspace = {
    id: 'task',
    projectGroupId: group.id,
    name: 'Task',
    folderPath: root,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const listeners = new Map<string, Set<(data: string) => void>>()
  const replay = new Map<string, string>()
  const tokens = new Map<string, string>()
  const agent = { ptyId: 'agent-pty', incarnationId: 'agent-incarnation' }
  let currentAgent = agent
  let launchedForeground = unprovableHost ? 'unknown' : 'agent'
  const write = vi.fn()
  const subscribe = (ptyId: string, listener: (data: string) => void) => {
    const subscriptions = listeners.get(ptyId) ?? new Set()
    listeners.set(ptyId, subscriptions)
    subscriptions.add(listener)
    return () => {
      subscriptions.delete(listener)
    }
  }
  const emit = (ptyId: string, data: string) => {
    replay.set(ptyId, data)
    for (const listener of listeners.get(ptyId) ?? []) {
      listener(data)
    }
  }
  const createTerminal = vi.fn(
    async (_selector: string, options: { title?: string }): Promise<RuntimeTerminalCreate> =>
      options.title === 'Setup'
        ? { handle: 'setup', ptyId: 'setup-pty', title: 'Setup', worktreeId: 'folder:task' }
        : {
            handle: 'agent',
            ptyId: 'agent-pty',
            incarnationId: agent.incarnationId,
            tabId: 'agent-tab',
            title: 'Codex',
            worktreeId: 'folder:task'
          }
  )
  const getLivePtyForHandle = (handle: string) => ({
    pty: handle === 'agent' ? currentAgent : { ptyId: 'setup-pty' }
  })
  const readiness = {
    getPtyId: () => currentAgent.ptyId,
    getForegroundProcess: async () => 'codex',
    subscribeToData: subscribe,
    readRecentOutput: (ptyId: string) => replay.get(ptyId),
    write
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked superclass is empty; these are every port reached by group pending-input delivery.
  const runtime = Object.assign(Reflect.construct(OrcaRuntimeWithGroupFolderSetup, []), {
    ptyController: { spawn: vi.fn() },
    getLivePtyForHandle,
    createTerminal,
    getWorktreeStartupReadinessHost: () => readiness,
    readLaunchedAgentForeground: async () => launchedForeground,
    launchedAgentHostProvesAgent: () => !unprovableHost,
    launchedAgentHostProvesShellAlone: () => false,
    launchedAgentTerminalIdentity: () => currentAgent,
    subscribeToTerminalData: subscribe,
    shouldProvisionWorktreeInBackground: () => true,
    provisionManagedWorktreeTerminals: (args: Parameters<typeof provisionWorktreeTerminals>[1]) =>
      provisionWorktreeTerminals(
        {
          canSpawn: () => true,
          createTerminal,
          setTabTitle: async () => {},
          setTabColor: async () => {},
          getPtyId: () => 'setup-pty',
          recordSetupCompletionToken: (ptyId, token) => {
            tokens.set(ptyId, token)
            if (fast) {
              emit(ptyId, `\n__ORCA_SETUP_COMPLETE__:${token}:0\n`)
            }
          }
        },
        args
      )
  }) as { localWorktreeTerminalPorts: (...args: unknown[]) => RuntimeLocalWorktreeTerminalPorts }
  const waitHost = {
    getLivePtyForHandle,
    setupCompletionTokenByPtyId: tokens,
    recentPtyOutputById: new Map([['setup-pty', { read: () => replay.get('setup-pty') }]]),
    subscribeToTerminalData: subscribe,
    waitForTerminal: (_handle: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
  }
  const wait = (handle: string, signal: AbortSignal) =>
    OrcaRuntimeWithStartTuiIdleVisibleReadProbe.prototype.waitForSetupTerminalCompletion.call(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every host port used by the production completion observer.
      waitHost as never,
      handle,
      signal
    )
  return {
    args: {
      group,
      workspace,
      input: {
        projectGroupId: group.id,
        startupCommand: 'codex --model custom',
        startupEnv: { CUSTOM: 'preserved' },
        startupAgent: 'codex' as const,
        startupPrompt: 'Inspect the linked task',
        startupPromptDelivery: delivery
      },
      settings: getDefaultSettings(root),
      ports: runtime.localWorktreeTerminalPorts({}, () => {}, { id: 'folder:task' }),
      wait,
      buildStartup: vi.fn()
    },
    write,
    createTerminal,
    listeners,
    finish: (status: number) =>
      emit('setup-pty', `\n__ORCA_SETUP_COMPLETE__:${tokens.get('setup-pty')}:${status}\n`),
    ready: () => emit('agent-pty', '\x1b[?2004h\x1b]7501;state=idle:app=codex\x1b\\'),
    shell: () => {
      launchedForeground = 'shell'
    },
    replace: () => {
      currentAgent = { ptyId: 'replacement', incarnationId: 'replacement' }
    }
  }
}

it('returns creation before slow required Setup and starts real draft readiness only after observed success', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const result = await prepareGroupFolderCreation(f.args)
  expect(result.startupTerminal?.tabId).toBe('agent-tab')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.write).not.toHaveBeenCalled()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith(
    'agent-pty',
    '\x1b[200~Inspect the linked task\x1b[201~',
    'launch'
  )
  expect(f.args.buildStartup).not.toHaveBeenCalled()
  expect(f.createTerminal.mock.calls[0]?.[1]).toMatchObject({
    env: expect.objectContaining({ CUSTOM: 'preserved' })
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('replays fast Setup completion without losing the unsent draft', async () => {
  vi.useFakeTimers()
  const f = fixture(true)
  await prepareGroupFolderCreation(f.args)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith(
    'agent-pty',
    '\x1b[200~Inspect the linked task\x1b[201~',
    'launch'
  )
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['draft', '\x1b[200~Inspect the linked task\x1b[201~'],
  ['auto-submit', 'Inspect the linked task\r']
] as const)('delivers %s once on a ready Windows-hosted WSL pane', async (delivery, expected) => {
  vi.useFakeTimers()
  const f = fixture(false, true, delivery)
  await prepareGroupFolderCreation(f.args)
  expect(f.write).not.toHaveBeenCalled()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith('agent-pty', expected, 'launch')
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a replaced Windows-hosted WSL target before typed followup', async () => {
  vi.useFakeTimers()
  const f = fixture(false, true, 'auto-submit')
  await prepareGroupFolderCreation(f.args)
  f.replace()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['failed setup', 'replaced agent'] as const)(
  'never writes pending text after %s',
  async (failure) => {
    vi.useFakeTimers()
    const f = fixture()
    await prepareGroupFolderCreation(f.args)
    f.finish(failure === 'failed setup' ? 1 : 0)
    await vi.advanceTimersByTimeAsync(0)
    if (failure === 'replaced agent') {
      f.replace()
    }
    f.ready()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('refuses a proven shell after stale WSL draft readiness', async () => {
  vi.useFakeTimers()
  const f = fixture(false, true)
  await prepareGroupFolderCreation(f.args)
  f.shell()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
