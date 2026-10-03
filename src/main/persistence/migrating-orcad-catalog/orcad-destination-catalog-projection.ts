/** How a source catalog row looks once a local orcad owns it: no SSH connection or host. */
import type { Repo } from '../../../shared/repo-types'

export function toOrcadDestinationRepository(source: Repo): Repo {
  const destination = structuredClone(source)
  delete destination.connectionId
  delete destination.executionHostId
  return destination
}
