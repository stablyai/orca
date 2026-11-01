import type { SshTarget } from '../../shared/ssh-types'
import type { WslOrcadHostTarget } from '../wsl/wsl-orcad-host-target'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import type { OrcadLaunchDetach } from '../managed-server/install/orcad-remote-launch'

/** Only id/label have the same meaning across host kinds. */
export type OrcadHostTarget = SshTarget | WslOrcadHostTarget

export function isWslOrcadHostTarget(target: OrcadHostTarget): target is WslOrcadHostTarget {
  return 'kind' in target && target.kind === 'wsl'
}

export type OrcadHostTransport = RemoteInstallTransport & {
  getTarget(): OrcadHostTarget
  /** Absent on SSH, which detaches with nohup. */
  readonly orcadLaunchDetach?: OrcadLaunchDetach
  /** Pass client-only host facts at launch; SSH adds none. */
  readonly orcadLaunchEnv?: (
    launch: OrcadLaunchEnvRequest
  ) => Promise<readonly OrcadLaunchEnvEntry[]>
}

/** The slot being launched; entries only its own build understands must check the version. */
export type OrcadLaunchEnvRequest = { readonly fullVersion: string }

/** `keep-existing` applies the value only when the launching shell has none, so a user's own setting wins. */
export type OrcadLaunchEnvEntry = readonly [name: string, value: string, mode?: 'keep-existing']
