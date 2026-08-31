/**
 * What a client does when it finds both a relay and an orcad installed on one host.
 *
 * `docs/design/shipping-orcad.html` §06 draws the line the boundary doc actually draws:
 * two *directories* on disk are fine and permanent; two *registered targets* for one
 * machine are forbidden, because that is what splits a machine's worktrees across two
 * identities (`docs/reference/ssh-execution-boundary.md`).
 *
 * So the model is never inferred from the filesystem. It is decided by how the user
 * registered the host, and the on-disk inventory is only ever diagnostic. Inferring it —
 * "an orcad dir exists, so prefer orcad" — would let a GC pass, a half-finished install or
 * a stale tree silently re-point a live connection at a different execution identity.
 */
import { inventoryRemoteInstallDirs, type RemoteInstallModelId } from './remote-install-model'

/**
 * How this host is registered in the client's own records.
 *
 * `both` is representable on purpose: it is a state a user can reach by adding an SSH
 * target for a machine they have already paired, and the point of this module is to refuse
 * it loudly instead of picking one.
 */
export type RemoteHostRegistration = 'ssh-target' | 'orcad-peer' | 'both' | 'none'

export type RemoteInstallSelection =
  | {
      outcome: 'use'
      model: RemoteInstallModelId
      /** Other-model dirs present on this host. Left alone; never GC'd by the chosen model. */
      coexisting: string[]
      /** Non-null when there is something an operator should know but nothing to refuse over. */
      note: string | null
    }
  | {
      outcome: 'refuse'
      code: 'remote_host_registered_under_both_models' | 'remote_host_not_registered'
      reason: string
    }

/**
 * Choose the execution model for a connection to a host, given its registration and
 * whatever happens to be installed there.
 */
export function selectRemoteInstallModel(input: {
  registration: RemoteHostRegistration
  /** Raw directory names under `~/.orca-remote/`, as listed on the host. */
  installedDirNames: readonly string[]
}): RemoteInstallSelection {
  if (input.registration === 'both') {
    return {
      outcome: 'refuse',
      code: 'remote_host_registered_under_both_models',
      reason:
        'This machine is registered both as an SSH target and as a paired orcad peer. One ' +
        'machine must have one execution identity, or its worktrees and terminals split ' +
        'across two owners that cannot see each other. Remove one registration. Leaving ' +
        'both install directories on disk is fine and expected.'
    }
  }
  if (input.registration === 'none') {
    return {
      outcome: 'refuse',
      code: 'remote_host_not_registered',
      reason:
        'This machine has no execution model registered. Add it as an SSH target or pair it ' +
        'as an orcad peer; what is already installed on it does not decide which it is.'
    }
  }
  const model: RemoteInstallModelId = input.registration === 'ssh-target' ? 'relay' : 'orcad'
  const inventory = inventoryRemoteInstallDirs(input.installedDirNames)
  const coexisting = model === 'relay' ? inventory.orcad : inventory.relay
  return {
    outcome: 'use',
    model,
    coexisting,
    note:
      coexisting.length > 0
        ? `This host also has ${coexisting.length} ${model === 'relay' ? 'orcad' : 'relay'} ` +
          `install directory(ies) (${coexisting.join(', ')}). They are left untouched: each ` +
          'model garbage-collects only its own namespace.'
        : null
  }
}
