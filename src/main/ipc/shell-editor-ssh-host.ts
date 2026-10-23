import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import { fingerprintRuntimeSshTarget } from '../ssh/runtime-ssh-target-fingerprint'

export type ListRuntimeEnvironments = () => readonly Pick<
  KnownRuntimeEnvironment,
  'id' | 'orcadDeployment' | 'sshAccess'
>[]

export const listAppRuntimeEnvironments: ListRuntimeEnvironments = () =>
  listEnvironments(getAppEnvironment().getPath('userData'))

/** Whether `target` is the SSH host that owns the path: that host, or the one its server runs on. */
export function isEditorSshHostForOwner(
  target: SshTarget,
  ownerHostId: unknown,
  listRuntimeEnvironments: ListRuntimeEnvironments
): boolean {
  if (ownerHostId === toSshExecutionHostId(target.id)) {
    return true
  }
  const owner = typeof ownerHostId === 'string' ? parseExecutionHostId(ownerHostId) : null
  if (owner?.kind !== 'runtime') {
    return false
  }
  let environments: ReturnType<ListRuntimeEnvironments>
  try {
    environments = listRuntimeEnvironments()
  } catch {
    return false
  }
  // Why main re-derives it: the renderer's claim alone must not point an editor at another host.
  const environment = environments.find((entry) => entry.id === owner.environmentId)
  const link = environment ? getRuntimeSshAccess(environment) : undefined
  if (!environment || link?.sshTargetId !== target.id) {
    return false
  }
  // Why: a link that outlived its SSH registration names whatever host now reuses the id.
  if (target.generation !== link.sshTargetGeneration) {
    return false
  }
  if (getOrcadSshDeployment(environment)) {
    return getManagedOrcadFenceEnvironmentId(target) === environment.id
  }
  // Why: editing a host keeps its generation, so SSH access also pins the settings it was verified on.
  const access = environment.sshAccess
  return (
    !!access?.targetFingerprint && fingerprintRuntimeSshTarget(target) === access.targetFingerprint
  )
}
