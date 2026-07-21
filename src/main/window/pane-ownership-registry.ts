type PaneOwnerRecord = {
  webContentsId: number
  ptyId: string
  paneKey: string | null
  worktreeId: string
  tabId: string
}

type RegisterPaneOwnerArgs = {
  webContentsId: number
  ptyId: string
  paneKey?: string | null
  worktreeId: string
  tabId: string
}

type RegisterTabPaneOwnersArgs = {
  webContentsId: number
  ptyIds: string[]
  worktreeId: string
  tabId: string
}

class PaneOwnershipRegistry {
  private readonly ownersByPtyId = new Map<string, PaneOwnerRecord>()
  private primaryAppWebContentsId: number | null = null

  setPrimaryAppWebContentsId(webContentsId: number | null): void {
    this.primaryAppWebContentsId = webContentsId
  }

  isPrimaryAppWebContentsId(webContentsId: number): boolean {
    return this.primaryAppWebContentsId === webContentsId
  }

  registerPaneOwner(args: RegisterPaneOwnerArgs): void {
    if (!args.ptyId) {
      return
    }
    this.ownersByPtyId.set(args.ptyId, {
      webContentsId: args.webContentsId,
      ptyId: args.ptyId,
      paneKey: args.paneKey ?? null,
      worktreeId: args.worktreeId,
      tabId: args.tabId
    })
  }

  registerTabPaneOwners(args: RegisterTabPaneOwnersArgs): void {
    for (const ptyId of args.ptyIds) {
      this.registerPaneOwner({
        webContentsId: args.webContentsId,
        ptyId,
        worktreeId: args.worktreeId,
        tabId: args.tabId
      })
    }
  }

  clearPaneOwnerByWebContentsId(webContentsId: number): void {
    for (const [ptyId, owner] of this.ownersByPtyId) {
      if (owner.webContentsId === webContentsId) {
        this.ownersByPtyId.delete(ptyId)
      }
    }
    if (this.primaryAppWebContentsId === webContentsId) {
      this.primaryAppWebContentsId = null
    }
  }

  clearPaneOwnerByPtyId(ptyId: string): void {
    this.ownersByPtyId.delete(ptyId)
  }

  getOwnerForPty(ptyId: string): number | null {
    return this.ownersByPtyId.get(ptyId)?.webContentsId ?? null
  }

  getPtyIdsForTab(worktreeId: string, tabId: string): string[] {
    const ptyIds: string[] = []
    for (const owner of this.ownersByPtyId.values()) {
      if (owner.worktreeId === worktreeId && owner.tabId === tabId) {
        ptyIds.push(owner.ptyId)
      }
    }
    return ptyIds
  }

  getPtyIdsForWebContents(webContentsId: number): string[] {
    const ptyIds: string[] = []
    for (const owner of this.ownersByPtyId.values()) {
      if (owner.webContentsId === webContentsId) {
        ptyIds.push(owner.ptyId)
      }
    }
    return ptyIds
  }

  senderOwnsPty(sender: Electron.WebContents, ptyId: string): boolean {
    const owner = this.ownersByPtyId.get(ptyId)
    if (owner) {
      return sender.id === owner.webContentsId
    }
    return this.primaryAppWebContentsId !== null && sender.id === this.primaryAppWebContentsId
  }
}

export const paneOwnershipRegistry = new PaneOwnershipRegistry()
