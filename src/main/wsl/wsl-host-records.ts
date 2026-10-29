/** The distro list the UI shows against the WSL host records. */
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostDistro } from '../../shared/wsl-host-types'
import { sameWslDistro } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'

/** Each distro with the host it already backs, if any. */
export function withWslHostIds(
  candidates: readonly WslHostDistroCandidate[],
  records: readonly WslHostDeploymentRecord[]
): WslHostDistro[] {
  return candidates.map(({ id: _id, ...distro }) => ({
    ...distro,
    environmentId:
      records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
  }))
}
