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
  readonly orcadLaunchEnv?: () => Promise<readonly OrcadLaunchEnvEntry[]>
}

export type OrcadLaunchEnvEntry = readonly [name: string, value: string]
