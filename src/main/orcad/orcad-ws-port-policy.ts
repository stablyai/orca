import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'

type OrcadWsPortOptions = {
  wsPort?: number
  preferPinnedWsPort?: boolean
  requirePinnedWsPort?: boolean
}

/** Honor explicit ports; managed launches permit fallback because WSL distros share loopback. */
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
