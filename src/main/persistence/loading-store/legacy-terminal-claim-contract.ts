import type { Repo } from '../../../shared/repo-types'
import type {
  FolderHostCatalog,
  FolderHostWorkspace,
  FolderHostRepo
} from '../../../shared/folder-workspaces/folder-workspace-execution-host'
export type LegacyClaimLayout = {
  root?: { type: string; leafId?: string } | null
  ptyIdsByLeafId?: Record<string, string>
}
export type LegacyClaimSession = {
  tabsByWorktree?: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId?: Record<string, LegacyClaimLayout>
  remoteSessionIdsByTabId?: Record<string, string>
}
export type LegacyClaimState = FolderHostCatalog<
  FolderHostRepo &
    Pick<Repo, 'id'> &
    Partial<Omit<Repo, 'executionHostId' | 'orcadRetained'>> & { orcadRetained?: unknown }
> & {
  folderWorkspaces: readonly (FolderHostWorkspace & {
    folderPath: string
    orcadRetained?: unknown
  })[]
  workspaceSession: LegacyClaimSession
}
export type LegacyTerminalCatalogEpoch = {
  ready: Promise<boolean>
  complete: boolean
  finish: (complete: boolean) => void
}
export function catalogEpoch(complete: boolean): LegacyTerminalCatalogEpoch {
  const result = Promise.withResolvers<boolean>()
  if (complete) {
    result.resolve(true)
  }
  return { ready: result.promise, complete, finish: result.resolve }
}
