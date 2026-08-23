import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../shared/terminal-scrollback-limits'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalWindowTransferCoordinatorOptions } from './terminal-window-transfer-coordinator-options'
import { isTerminalWindowTransferSeed } from './terminal-window-transfer-seed-validation'
import {
  createTerminalWindowTransferHarness,
  ipcEvent,
  terminalWindowSeed,
  terminalWindowSession,
  type TerminalWindowTransferHarness
} from './terminal-window-transfer-test-fixture'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  screen: {
    getCursorScreenPoint: vi.fn(),
    getDisplayNearestPoint: vi.fn()
  }
}))

vi.mock('./pty', () => ({
  handoffPtyRendererOwnership: vi.fn(),
  registerPtyRenderer: vi.fn(),
  sendToPtyOwner: vi.fn()
}))

vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))

async function createCoordinator(
  h: TerminalWindowTransferHarness,
  overrides: Partial<TerminalWindowTransferCoordinatorOptions> = {}
) {
  const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
  return new TerminalWindowTransferCoordinator({
    store: {} as never,
    createSecondaryWindow: vi.fn(),
    windows: h.windows,
    sessions: h.sessions as never,
    owners: h.owners,
    getCursorPoint: () => ({ x: 700, y: 100 }),
    handoff: h.handoff,
    timeoutMs: 20,
    ...overrides
  })
}

function expectNoMutation(h: TerminalWindowTransferHarness): void {
  expect(h.sessions.set).not.toHaveBeenCalled()
  expect(h.sessions.seedWindow).not.toHaveBeenCalled()
  expect(h.handoff).not.toHaveBeenCalled()
}

describe('terminal window transfer authoritative preflight', () => {
  beforeEach(() => vi.clearAllMocks())

  const targetBackingCases: [string, (state: WorkspaceSessionState) => void][] = [
    [
      'legacy terminal tab',
      (state) => {
        state.tabsByWorktree.other = [terminalWindowSeed().tab]
      }
    ],
    [
      'terminal layout',
      (state) => {
        state.terminalLayoutsByTabId['tab-1'] = terminalWindowSeed().layout
      }
    ],
    [
      'unified tab id',
      (state) => {
        state.unifiedTabs = terminalWindowSession(true).unifiedTabs
      }
    ],
    [
      'unified entity id',
      (state) => {
        const unified = structuredClone(terminalWindowSession(true).unifiedTabs!)
        unified['wt-1']![0]!.id = 'shell-tab'
        state.unifiedTabs = unified
      }
    ],
    [
      'tab group membership',
      (state) => {
        state.tabGroups = terminalWindowSession(true).tabGroups
      }
    ],
    [
      'remote session key',
      (state) => {
        state.remoteSessionIdsByTabId = { 'tab-1': 'remote-old' }
      }
    ],
    [
      'other terminal PTY',
      (state) => {
        state.tabsByWorktree.other = [
          { ...terminalWindowSeed().tab, id: 'tab-other', ptyId: 'pty-1' }
        ]
      }
    ],
    [
      'other terminal layout PTY',
      (state) => {
        state.terminalLayoutsByTabId.other = {
          ...terminalWindowSeed().layout,
          ptyIdsByLeafId: { 'leaf-other': 'pty-1' }
        }
      }
    ]
  ]

  it.each(targetBackingCases)('rejects target %s without mutation', async (_name, mutate) => {
    const h = createTerminalWindowTransferHarness()
    const target = terminalWindowSession(false)
    mutate(target)
    h.records.set(h.target.id, target)
    const coordinator = await createCoordinator(h)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target_mismatch' })
    expectNoMutation(h)
  })

  it('rejects an extra owned PTY smuggled from another source tab', async () => {
    const h = createTerminalWindowTransferHarness()
    h.owners.claim('pty-2', h.source.webContents as never)
    const coordinator = await createCoordinator(h)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...terminalWindowSeed(),
        ptyIds: ['pty-1', 'pty-2']
      })
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_mismatch' })
    expectNoMutation(h)
  })

  it('rejects renderer-forged terminal tab and layout snapshots', async () => {
    for (const forged of [
      {
        ...terminalWindowSeed(),
        tab: { ...terminalWindowSeed().tab, title: 'Forged title' }
      },
      {
        ...terminalWindowSeed(),
        layout: { ...terminalWindowSeed().layout, titlesByLeafId: { 'leaf-1': 'Forged' } }
      }
    ]) {
      const h = createTerminalWindowTransferHarness()
      const coordinator = await createCoordinator(h)
      await expect(
        coordinator.detach(ipcEvent(h.source.webContents) as never, forged)
      ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_mismatch' })
      expectNoMutation(h)
    }
  })

  it('rejects a renderer-forged persisted group', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...terminalWindowSeed(),
        group: { ...terminalWindowSeed().group, id: 'forged-group' }
      })
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_mismatch' })
    expectNoMutation(h)
  })

  it('rejects a canonical workspace key for another worktree before mutation', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...terminalWindowSeed(),
        canonicalWorkspaceKey: 'worktree:other'
      })
    ).resolves.toEqual({ ok: false, error: 'invalid_terminal_transfer_seed' })
    expectNoMutation(h)
  })

  it('rejects a worktree attributed to another repo before mutation', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, {
        ...terminalWindowSeed(),
        repo: { ...terminalWindowSeed().repo, id: 'foreign-repo' }
      })
    ).resolves.toEqual({ ok: false, error: 'invalid_terminal_transfer_seed' })
    expectNoMutation(h)
  })

  it('accepts a repo-qualified worktree identity', () => {
    const seed = terminalWindowSeed()
    const worktreeId = 'wt-1::/tmp/worktree'

    expect(
      isTerminalWindowTransferSeed({
        ...seed,
        canonicalWorkspaceKey: `worktree:${worktreeId}`,
        worktreeId,
        tab: { ...seed.tab, worktreeId },
        group: { ...seed.group, worktreeId }
      })
    ).toBe(true)
  })

  it.each([
    {
      root: null,
      activeLeafId: 'single-pane',
      expandedLeafId: null
    },
    {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { retained: 'pty-1' },
      buffersByLeafId: { retained: '' }
    }
  ])('accepts a structurally valid rootless terminal layout', (layout) => {
    expect(isTerminalWindowTransferSeed({ ...terminalWindowSeed(), layout })).toBe(true)
  })

  it('still rejects non-string rootless layout records', () => {
    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { retained: 42 }
        }
      })
    ).toBe(false)
  })

  it('rejects a rootless layout whose backing records exceed the shared leaf limit', () => {
    const record = (prefix: string, count: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`${prefix}-${index}`, `${prefix}-${index}`])
      )

    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: record('pty', 257),
          buffersByLeafId: record('buffer', 256),
          scrollbackRefsByLeafId: record('scrollback', 256),
          titlesByLeafId: record('title', 256)
        }
      })
    ).toBe(false)
  })

  it('rejects an oversized rootless layout leaf key', () => {
    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { ['leaf'.repeat(1_025)]: 'pty-1' }
        }
      })
    ).toBe(false)
  })

  it('rejects an oversized rootless layout backing value', () => {
    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          buffersByLeafId: {
            retained: 'x'.repeat(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT + 1)
          }
        }
      })
    ).toBe(false)
  })

  it('rejects a multibyte rootless buffer above the UTF-8 byte limit', () => {
    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          buffersByLeafId: {
            retained: 'é'.repeat(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT / 2 + 1)
          }
        }
      })
    ).toBe(false)
  })

  it('accepts a multibyte rootless buffer at the UTF-8 byte limit', () => {
    expect(
      isTerminalWindowTransferSeed({
        ...terminalWindowSeed(),
        layout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          buffersByLeafId: {
            retained: 'é'.repeat(TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT / 2)
          }
        }
      })
    ).toBe(true)
  })

  it('accepts a legacy local folder workspace without persisted groups', async () => {
    const h = createTerminalWindowTransferHarness()
    const folderSeed = {
      ...terminalWindowSeed(),
      canonicalWorkspaceKey: 'folder:folder-1' as const,
      worktreeId: 'folder:folder-1',
      tab: { ...terminalWindowSeed().tab, worktreeId: 'folder:folder-1' },
      group: { ...terminalWindowSeed().group, worktreeId: 'folder:folder-1' }
    }
    const source = terminalWindowSession(false)
    source.activeWorkspaceKey = null
    source.activeWorkspaceExecutionHostId = null
    source.activeWorktreeId = 'folder:folder-1'
    source.tabsByWorktree = { 'folder:folder-1': [folderSeed.tab] }
    source.terminalLayoutsByTabId = { 'tab-1': folderSeed.layout }
    const target = structuredClone(source)
    target.tabsByWorktree = {}
    target.terminalLayoutsByTabId = {}
    h.records.set(h.source.id, source)
    h.records.set(h.target.id, target)
    const coordinator = await createCoordinator(h)
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, folderSeed)
    ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
  })
})
