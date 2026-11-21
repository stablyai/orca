// ORCA_REMOTE_HOME roots managed-server state where the login home does not persist, e.g. containers (#42820).
import { ORCA_REMOTE_HOME_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-managed-launch-env'
import {
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'

const REMOTE_HOME_PREFIX = `${ORCA_REMOTE_HOME_ENV}=`

/** Shell word for the directory holding .orca, .orca-remote and machine data roots on a POSIX host. */
export const ORCAD_REMOTE_ROOT_SHELL = `"\${${ORCA_REMOTE_HOME_ENV}:-$HOME}"`

/** Probe line for the hostname section; newlines become spaces so a multi-line value is refused. */
export const ORCAD_REMOTE_HOME_PROBE = `printf '${REMOTE_HOME_PREFIX}[%s]\\n' "$(printf %s "\${${ORCA_REMOTE_HOME_ENV}-}" | tr '\\n' ' ')";`

/** An unset or empty override means the login home; anything else must be an absolute path. */
export function refuseUnusableOrcadRemoteHome(
  lines: readonly string[],
  host: RemoteHostPlatform
): void {
  const value = lines
    .find((candidate) => candidate.startsWith(REMOTE_HOME_PREFIX))
    ?.slice(REMOTE_HOME_PREFIX.length)
  const remoteHome = value?.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : ''
  if (remoteHome && (remoteHome !== remoteHome.trim() || !validateRemoteHome(remoteHome, host))) {
    throw new Error(
      `${ORCA_REMOTE_HOME_ENV} is set to "${remoteHome.slice(0, 80)}", which Orca can't use. ` +
        'Use an absolute path, then reconnect.'
    )
  }
}
