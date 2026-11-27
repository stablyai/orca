import { rm } from 'node:fs/promises'
import type { AiVaultSessionPathRemover } from './session-delete'

export type HostAiVaultSessionDeleteDeps = {
  removePath: AiVaultSessionPathRemover
  invalidateMultiHostListCache?: () => void
  invalidateBackgroundCache?: (paths: string[]) => Promise<void>
}

/** Plain-Node hosts have no Trash, so a remote delete removes the files outright. */
export const removeAiVaultSessionPathPermanently: AiVaultSessionPathRemover = (removal) =>
  rm(removal.path, { recursive: removal.kind === 'directory', force: true })

let remoteDeleteDeps: HostAiVaultSessionDeleteDeps = {
  removePath: removeAiVaultSessionPathPermanently
}

/** An Electron host swaps in its Trash and its own multi-host cache; orcad keeps the default. */
export function configureRemoteAiVaultSessionDelete(deps: HostAiVaultSessionDeleteDeps): void {
  remoteDeleteDeps = deps
}

export function getRemoteAiVaultSessionDeleteDeps(): HostAiVaultSessionDeleteDeps {
  return remoteDeleteDeps
}
