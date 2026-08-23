import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { vi, type Mock } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  TerminalWindowTransferCommand,
  TerminalWindowTransferSeed
} from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaWindowManager } from '../window/orca-window-manager'
import { PtyRendererOwners } from './pty-renderer-owners'

export class FakeWebContents extends EventEmitter {
  readonly id: number
  readonly mainFrame = {}
  readonly send: Mock<(channel: string, command: TerminalWindowTransferCommand) => void> = vi.fn()
  destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  getType(): string {
    return 'window'
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

export function ipcEvent(sender: FakeWebContents, senderFrame: object | null = sender.mainFrame) {
  return { sender, senderFrame }
}

export class FakeWindow extends EventEmitter {
  readonly id: number
  readonly #webContents: FakeWebContents
  bounds: Electron.Rectangle
  visible = true
  destroyed = false
  readonly show: Mock<() => void> = vi.fn()
  readonly focus: Mock<() => void> = vi.fn()
  readonly close: Mock<() => void> = vi.fn()
  readonly destroy: Mock<() => void> = vi.fn(() => {
    this.destroyed = true
  })

  constructor(id: number, bounds: Electron.Rectangle, webContentsId = id + 100) {
    super()
    this.id = id
    this.bounds = bounds
    this.#webContents = new FakeWebContents(webContentsId)
  }

  get webContents(): FakeWebContents {
    if (this.destroyed) {
      throw new Error('Object has been destroyed')
    }
    return this.#webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  getBounds(): Electron.Rectangle {
    return this.bounds
  }
}

export function terminalWindowSeed(): TerminalWindowTransferSeed {
  return {
    tabId: 'tab-1',
    hostId: 'local',
    canonicalWorkspaceKey: 'worktree:wt-1',
    worktreeId: 'wt-1',
    repo: {
      id: 'repo-1',
      path: '/tmp/repo-1',
      displayName: 'Repo 1',
      badgeColor: '#000000',
      addedAt: 1
    },
    group: {
      id: 'group-1',
      worktreeId: 'wt-1',
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      recentTabIds: ['tab-1']
    },
    tab: {
      id: 'tab-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    layout: {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
    },
    ptyIds: ['pty-1']
  }
}

export function terminalWindowSession(withTab: boolean, matching = true): WorkspaceSessionState {
  const seed = terminalWindowSeed()
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorkspaceKey: matching ? 'worktree:wt-1' : 'worktree:other',
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    tabsByWorktree: withTab ? { 'wt-1': [seed.tab] } : {},
    terminalLayoutsByTabId: withTab ? { 'tab-1': seed.layout } : {},
    ...(withTab
      ? {
          unifiedTabs: {
            'wt-1': [
              {
                id: seed.tabId,
                entityId: seed.tabId,
                groupId: seed.group.id,
                worktreeId: seed.worktreeId,
                contentType: 'terminal' as const,
                label: seed.tab.title,
                customLabel: seed.tab.customTitle,
                color: seed.tab.color,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          tabGroups: { 'wt-1': [seed.group] },
          tabGroupLayouts: {
            'wt-1': { type: 'leaf' as const, groupId: seed.group.id }
          },
          activeGroupIdByWorktree: { 'wt-1': seed.group.id },
          remoteSessionIdsByTabId: { [seed.tabId]: seed.ptyIds[0]! }
        }
      : {})
  }
}

export type TerminalWindowTransferHarness = {
  windows: OrcaWindowManager
  source: FakeWindow
  target: FakeWindow
  owners: PtyRendererOwners
  records: Map<number, WorkspaceSessionState>
  sessions: {
    get: Mock<(windowId: number) => WorkspaceSessionState>
    isWindowEmptyAcrossHosts: Mock<(windowId: number) => boolean>
    set: Mock<(windowId: number, state: WorkspaceSessionState) => void>
    seedWindow: Mock
    retire: Mock
  }
  calls: string[]
  handoff: Mock<(ids: readonly string[], from: WebContents, to: WebContents) => void>
}

export function createTerminalWindowTransferHarness(
  options: { targetMatching?: boolean; createTarget?: boolean } = {}
): TerminalWindowTransferHarness {
  const windows = new OrcaWindowManager()
  const source = new FakeWindow(1, { x: 0, y: 0, width: 500, height: 500 })
  const target = new FakeWindow(2, { x: 600, y: 0, width: 500, height: 500 })
  windows.register(source as never, 'control')
  if (!options.createTarget) {
    windows.register(target as never, 'secondary')
  }
  const owners = new PtyRendererOwners()
  owners.registerRenderer(source.webContents as never)
  owners.registerRenderer(target.webContents as never)
  owners.markDispatcherReady(source.webContents as never)
  owners.markDispatcherReady(target.webContents as never)
  owners.claim('pty-1', source.webContents as never)
  const records = new Map<number, WorkspaceSessionState>([
    [source.id, terminalWindowSession(true)],
    [target.id, terminalWindowSession(false, options.targetMatching !== false)]
  ])
  const calls: string[] = []
  const sessions = {
    get: vi.fn((windowId: number) => structuredClone(records.get(windowId)!)),
    isWindowEmptyAcrossHosts: vi.fn(() => true),
    set: vi.fn((windowId: number, state: WorkspaceSessionState) => {
      calls.push(`set:${windowId}`)
      records.set(windowId, structuredClone(state))
    }),
    seedWindow: vi.fn(),
    retire: vi.fn()
  }
  const handoff: TerminalWindowTransferHarness['handoff'] = vi.fn((ids, from, to) => {
    calls.push(`handoff:${from.id}->${to.id}`)
    owners.handoff(ids, from, to)
  })
  return { windows, source, target, owners, records, sessions, calls, handoff }
}
