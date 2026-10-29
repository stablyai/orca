import { getAppEnvironment } from '../../shared/app-environment'
import { hasRemoteFilesystemOwner } from '../ipc/remote-filesystem-owner'
import {
  hydrateFilesystemHostFailureDomains,
  reconcileFilesystemHostFailureDomains
} from './filesystem-host-read-client'

type CatalogRepo = {
  path: string
  connectionId?: string | null
  executionHostId?: string | null
}

export function attachFilesystemHostRuntimeCatalog(source: {
  getRepos(): readonly CatalogRepo[]
  onClientEvent(listener: (event: { type: string }) => void): () => void
}): () => void {
  const environment = getAppEnvironment()
  hydrateFilesystemHostFailureDomains([
    environment.getPath('home'),
    environment.getPath('userData')
  ])
  const reconcile = (): void => {
    reconcileFilesystemHostFailureDomains(
      source
        .getRepos()
        .filter((repo) => !hasRemoteFilesystemOwner(repo))
        .map((repo) => repo.path)
    )
  }
  reconcile()
  return source.onClientEvent((event) => {
    if (event.type === 'reposChanged') {
      reconcile()
    }
  })
}
