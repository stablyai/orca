import { beforeEach, describe, expect, it } from 'vitest'
import { paneOwnershipRegistry } from './pane-ownership-registry'

describe('paneOwnershipRegistry', () => {
  beforeEach(() => {
    paneOwnershipRegistry.clearPaneOwnerByWebContentsId(17)
    paneOwnershipRegistry.clearPaneOwnerByWebContentsId(18)
    paneOwnershipRegistry.clearPaneOwnerByPtyId('pty-1')
    paneOwnershipRegistry.clearPaneOwnerByPtyId('pty-2')
    paneOwnershipRegistry.clearPaneOwnerByPtyId('pty-3')
    paneOwnershipRegistry.setPrimaryAppWebContentsId(null)
  })

  it('registers ownership by PTY id and pane key', () => {
    paneOwnershipRegistry.registerPaneOwner({
      webContentsId: 17,
      ptyId: 'pty-1',
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1'
    })

    expect(paneOwnershipRegistry.getOwnerForPty('pty-1')).toBe(17)
    expect(paneOwnershipRegistry.getPtyIdsForTab('worktree-1', 'tab-1')).toEqual(['pty-1'])
    expect(paneOwnershipRegistry.senderOwnsPty({ id: 17 } as Electron.WebContents, 'pty-1')).toBe(
      true
    )
    expect(paneOwnershipRegistry.senderOwnsPty({ id: 18 } as Electron.WebContents, 'pty-1')).toBe(
      false
    )
  })

  it('registers tab-level ownership for split-pane PTYs', () => {
    paneOwnershipRegistry.registerTabPaneOwners({
      webContentsId: 17,
      ptyIds: ['pty-1', 'pty-2'],
      worktreeId: 'worktree-1',
      tabId: 'tab-1'
    })

    expect(paneOwnershipRegistry.getOwnerForPty('pty-1')).toBe(17)
    expect(paneOwnershipRegistry.getOwnerForPty('pty-2')).toBe(17)
    expect(paneOwnershipRegistry.getPtyIdsForTab('worktree-1', 'tab-1')).toEqual(['pty-1', 'pty-2'])
  })

  it('lists PTY ids for an owning webContents id', () => {
    paneOwnershipRegistry.registerTabPaneOwners({
      webContentsId: 17,
      ptyIds: ['pty-1', 'pty-2'],
      worktreeId: 'worktree-1',
      tabId: 'tab-1'
    })
    paneOwnershipRegistry.registerPaneOwner({
      webContentsId: 18,
      ptyId: 'pty-3',
      worktreeId: 'worktree-1',
      tabId: 'tab-2'
    })

    expect(paneOwnershipRegistry.getPtyIdsForWebContents(17)).toEqual(['pty-1', 'pty-2'])
  })

  it('cleans up owners by webContents id and by PTY id', () => {
    paneOwnershipRegistry.registerTabPaneOwners({
      webContentsId: 17,
      ptyIds: ['pty-1', 'pty-2'],
      worktreeId: 'worktree-1',
      tabId: 'tab-1'
    })
    paneOwnershipRegistry.registerPaneOwner({
      webContentsId: 18,
      ptyId: 'pty-3',
      worktreeId: 'worktree-1',
      tabId: 'tab-2'
    })

    paneOwnershipRegistry.clearPaneOwnerByWebContentsId(17)
    expect(paneOwnershipRegistry.getOwnerForPty('pty-1')).toBeNull()
    expect(paneOwnershipRegistry.getOwnerForPty('pty-2')).toBeNull()
    expect(paneOwnershipRegistry.getOwnerForPty('pty-3')).toBe(18)

    paneOwnershipRegistry.clearPaneOwnerByPtyId('pty-3')
    expect(paneOwnershipRegistry.getOwnerForPty('pty-3')).toBeNull()
  })

  it('identifies the registered primary app window', () => {
    paneOwnershipRegistry.setPrimaryAppWebContentsId(17)

    expect(paneOwnershipRegistry.isPrimaryAppWebContentsId(17)).toBe(true)
    expect(paneOwnershipRegistry.isPrimaryAppWebContentsId(18)).toBe(false)
  })

  it('falls back to the registered primary app window when no detached owner exists', () => {
    expect(paneOwnershipRegistry.getOwnerForPty('pty-1')).toBeNull()
    expect(paneOwnershipRegistry.senderOwnsPty({ id: 99 } as Electron.WebContents, 'pty-1')).toBe(
      false
    )

    paneOwnershipRegistry.setPrimaryAppWebContentsId(17)

    expect(paneOwnershipRegistry.senderOwnsPty({ id: 17 } as Electron.WebContents, 'pty-1')).toBe(
      true
    )
    expect(paneOwnershipRegistry.senderOwnsPty({ id: 18 } as Electron.WebContents, 'pty-1')).toBe(
      false
    )
  })
})
