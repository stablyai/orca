import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'

export type OrcadWsPortOptions = {
  wsPort?: number
  preferPinnedWsPort?: boolean
  requirePinnedWsPort?: boolean
}

/**
 * An operator's `--port` must bind exactly that port. A managed launch passes the default port as
 * a preference and reads the bound port back from readiness: WSL2 distros share one VM loopback,
 * and an SSH host's 6768 may already be taken, so it must keep the fallback ladder.
 */
export function orcadWsPortOptions(
  port: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): OrcadWsPortOptions {
  if (port === undefined) {
    return {}
  }
  const managed = Boolean(env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV])
  return {
    wsPort: port,
    preferPinnedWsPort: true,
    ...(managed ? {} : { requirePinnedWsPort: true })
  }
}
