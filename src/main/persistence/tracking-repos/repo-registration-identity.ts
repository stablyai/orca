import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { getRepoKind } from '../../../shared/repo-kind'

const identities = new WeakMap<Repo, object>()

function registrationIdentity(repo: Repo): object {
  let identity = identities.get(repo)
  if (!identity) {
    identity = {}
    identities.set(repo, identity)
  }
  return identity
}

export function inheritRepoRegistrationIdentity(source: Repo, projection: Repo): void {
  identities.set(projection, registrationIdentity(source))
}

export function hasSameRepoRegistration(
  current: Repo | null | undefined,
  owner: Repo | null | undefined
): boolean {
  if (!current || !owner) {
    return current === owner
  }
  return (
    registrationIdentity(current) === registrationIdentity(owner) &&
    current.id === owner.id &&
    current.path === owner.path &&
    getRepoKind(current) === getRepoKind(owner) &&
    getRepoExecutionHostId(current) === getRepoExecutionHostId(owner) &&
    (current.connectionId ?? null) === (owner.connectionId ?? null)
  )
}
