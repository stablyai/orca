import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { getDefaultRepoHookSettings, getDefaultSettings } from '../../../../shared/constants'
import { createProjectGroup } from '../../../../shared/project-groups'
import { OrcaRuntimeWithGroupFolderSetup } from './runtime-group-folder-setup-host'
import { provisionWorktreeTerminals } from '../startup/runtime-worktree-terminal-provisioning'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from '../../terminal/wait/terminal-wait-visible-probe'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'
import { waitForFreshComposerOnPty } from '../../terminal/wait/launch-composer-watch'
import { readFreshComposerHold } from '../../terminal/wait/launched-agent-composer-readiness'
import { waitForTerminalComposer } from '../../terminal/wait/terminal-composer-lifetime'
import { RuntimeTerminalWaiterRegistry } from '../../terminal/wait/terminal-waiter-registry'
import { buildPtyTerminalWaitResult } from '../../terminal/wait/terminal-wait-results'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

export function fixture(
  fast = false,
  unprovableHost = false,
  delivery: 'draft' | 'auto-submit' = 'draft',
  shellAloneProvable = false
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
  const agent = {
    ptyId: 'agent-pty',
    incarnationId: 'agent-incarnation',
    connected: true,
    lastExitCode: null
  }
  let currentAgent = agent
  let launchedForeground = unprovableHost ? 'unknown' : 'agent'
  let ordinaryForeground: string | null = 'codex'
  let afterForeground: (() => void) | undefined
  let afterReady: (() => void) | undefined
  const waiters = new RuntimeTerminalWaiterRegistry()
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
    getForegroundProcess: async () => ordinaryForeground,
    subscribeToData: subscribe,
    readRecentOutput: (ptyId: string) => replay.get(ptyId),
    write
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test supplies every port reached by group pending-input delivery.
  const runtime = Object.assign(Reflect.construct(OrcaRuntimeWithGroupFolderSetup, []), {
    ptyController: { spawn: vi.fn() },
    getLivePtyForHandle,
    createTerminal,
    getWorktreeStartupReadinessHost: () => readiness,
    readLaunchedAgentForeground: async () => {
      const result = launchedForeground
      afterForeground?.()
      afterForeground = undefined
      return result
    },
    launchedAgentHostProvesAgent: () => !unprovableHost,
    launchedAgentHostProvesShellAlone: () => shellAloneProvable,
    launchedAgentTerminalIdentity: () => currentAgent,
    subscribeToTerminalData: subscribe,
    waitForFreshWorkerComposer: (
      handle: string,
      selectedAgent: TuiAgent,
      timeoutMs: number,
      options: {
        signal?: AbortSignal
        requireComposerMarker?: boolean
        stopOnDialog?: boolean
      } = {}
    ) =>
      waitForTerminalComposer(
        {
          handle,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readiness reads only the lifetime fields supplied by this PTY fixture.
          getTarget: () => currentAgent as never,
          buildResult: () => {
            const result = buildPtyTerminalWaitResult(handle, 'tui-idle', currentAgent)
            afterReady?.()
            afterReady = undefined
            return result
          },
          waiters,
          signal: options.signal
        },
        (target, stop) =>
          waitForFreshComposerOnPty(
            {
              readiness,
              readHold: (ptyId) => readFreshComposerHold(replay.get(ptyId) ?? '', null),
              readForeground: async () => launchedForeground
            },
            target.ptyId,
            selectedAgent,
            timeoutMs,
            {
              requireComposerMarker: options.requireComposerMarker ?? false,
              stopOnDialog: options.stopOnDialog ?? false,
              stop
            }
          )
      ),
    waitForTerminal: async () => ({ satisfied: false, status: 'timeout' }),
    sendTerminalAgentPrompt: async (
      handle: string,
      text: string,
      options: { beforeWrite: (ptyId: string) => Promise<void> }
    ) => {
      await options.beforeWrite('agent-pty')
      write('agent-pty', text, 'launch')
      await options.beforeWrite('agent-pty')
      write('agent-pty', '\r', 'launch')
      return { handle, accepted: true, bytesWritten: text.length + 1 }
    },
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
    output: (data: string) => emit('agent-pty', data),
    ordinaryForeground: (name: string | null) => {
      ordinaryForeground = name
    },
    replaceAfterForeground: () => {
      afterForeground = () => {
        currentAgent = { ...agent, incarnationId: 'replacement' }
      }
    },
    replaceAfterReady: () => {
      afterReady = () => {
        currentAgent = { ...agent, incarnationId: 'replacement' }
      }
    },
    finish: (status: number) =>
      emit('setup-pty', `\n__ORCA_SETUP_COMPLETE__:${tokens.get('setup-pty')}:${status}\n`),
    ready: () => emit('agent-pty', '\x1b[?2004h\x1b]7501;state=idle:app=codex\x1b\\'),
    shell: () => {
      launchedForeground = 'shell'
    },
    replace: () => {
      currentAgent = { ...agent, ptyId: 'replacement', incarnationId: 'replacement' }
    }
  }
}
