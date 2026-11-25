// A shared agent's home on this computer: a folder workspace in the hidden Bots group, as any bot
// home is, so its chats open in tabs this desktop keeps. Its owner's workspaces are never listed here.
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BotShareIdSchema } from '../../../shared/bots/bot-team-shares'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { botsProjectGroupId, type HomeStore } from '../bot-home-workspace'
import type { SharedBotHostStore } from './shared-bot-host-store'

export type SharedBotHomeDeps = {
  userDataPath: string
  botsRoot: () => string
  store: HomeStore & { getFolderWorkspaces: () => readonly Pick<FolderWorkspace, 'id'>[] }
  createFolderWorkspace: (input: {
    projectGroupId: string
    name: string
    folderPath: string
  }) => Promise<Pick<FolderWorkspace, 'id'>>
  /** The app's own delete: its tabs, terminals and session state go with it. */
  deleteFolderWorkspace: (id: string) => Promise<unknown>
}

/** `<userData>/shared-agents/<shareId>`; checked here too, as the folder is removed recursively. */
export function sharedBotHomeFolder(userDataPath: string, shareId: string): string {
  return join(userDataPath, 'shared-agents', BotShareIdSchema.parse(shareId))
}

type SharedBotHomeShare = { shareId: string; botName: string; homeWorkspaceId?: string }

export class SharedBotHomes {
  constructor(private readonly deps: SharedBotHomeDeps) {}

  /** Whether the home `id` names is still in the store (the user can't remove it, but a reset can). */
  has(id: string | undefined): boolean {
    return id !== undefined && this.deps.store.getFolderWorkspaces().some((home) => home.id === id)
  }

  /** Makes the share's home, named for its agent, and returns its folder workspace id. */
  async make(share: SharedBotHomeShare): Promise<string> {
    const folderPath = sharedBotHomeFolder(this.deps.userDataPath, share.shareId)
    await mkdir(folderPath, { recursive: true })
    const workspace = await this.deps.createFolderWorkspace({
      projectGroupId: botsProjectGroupId(this.deps.store, this.deps.botsRoot()),
      name: share.botName,
      folderPath
    })
    return workspace.id
  }

  /** A removed share's home goes with it; every kept share has one, made the first time it is seen. */
  async settle(gone: readonly SharedBotHomeShare[], store: SharedBotHostStore): Promise<void> {
    for (const share of gone) {
      await this.remove(share).catch((error: unknown) =>
        console.warn('[shared-agents] could not remove a shared agent’s home', error)
      )
    }
    for (const share of store.list()) {
      if (this.has(share.homeWorkspaceId)) {
        continue
      }
      try {
        const homeWorkspaceId = await this.make(share)
        store.put({ ...(store.get(share.shareId) ?? share), homeWorkspaceId })
      } catch (error) {
        console.warn('[shared-agents] could not make a shared agent’s home', error)
      }
    }
  }

  /** Removes the share's home with its tabs, and its folder: only that one. */
  async remove(share: SharedBotHomeShare): Promise<void> {
    if (share.homeWorkspaceId && this.has(share.homeWorkspaceId)) {
      await this.deps.deleteFolderWorkspace(share.homeWorkspaceId)
    }
    await rm(sharedBotHomeFolder(this.deps.userDataPath, share.shareId), {
      recursive: true,
      force: true
    })
  }
}
