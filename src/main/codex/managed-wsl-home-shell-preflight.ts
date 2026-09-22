import { realpath } from 'node:fs/promises'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { CodexWslRuntimeHookTarget } from './codex-wsl-hook-install-plan'
import { codexHookService } from './hook-service'
import {
  isAbsolutePosixPathWithoutDotSegments,
  resolveManagedWslCodexHome,
  wslRuntimeHomePathsEqual
} from './managed-wsl-codex-home-registry'

type WslShellPreflightEnvironment = {
  CODEX_HOME?: string
  ORCA_CODEX_HOME?: string
  WSL_DISTRO_NAME?: string
}

const WSL_MANAGED_HOME_REALPATH_TIMEOUT_MS = 5_000

export type ManagedWslCodexShellPreflightTarget = {
  runtimeHomePath: string
  wslDistro: string
}

export function resolveManagedWslCodexShellPreflightTarget(
  env: WslShellPreflightEnvironment
): ManagedWslCodexShellPreflightTarget | null {
  const codexHome = env.CODEX_HOME?.trim()
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim()
  const wslDistro = env.WSL_DISTRO_NAME?.trim()
  if (
    !codexHome ||
    codexHome !== orcaCodexHome ||
    !wslDistro ||
    /[\\/\r\n]/.test(wslDistro) ||
    !isAbsolutePosixPathWithoutDotSegments(codexHome)
  ) {
    return null
  }
  const runtimeHomePath = resolveManagedWslCodexHome(wslDistro, codexHome)
  return runtimeHomePath ? { runtimeHomePath, wslDistro } : null
}

export async function prepareManagedWslCodexHomeBeforeShellLaunch(args: {
  env: WslShellPreflightEnvironment
  hooksEnabled: boolean
  install?: (
    runtimeHomePath: string,
    target: CodexWslRuntimeHookTarget
  ) => AgentHookInstallStatus | Promise<AgentHookInstallStatus | null> | null
}): Promise<AgentHookInstallStatus | null> {
  if (!args.hooksEnabled) {
    return null
  }
  const target = resolveManagedWslCodexShellPreflightTarget(args.env)
  if (!target) {
    return null
  }
  const realHome = await withTimeout(
    realpath(target.runtimeHomePath),
    WSL_MANAGED_HOME_REALPATH_TIMEOUT_MS,
    null
  )
  if (!realHome || !wslRuntimeHomePathsEqual(realHome, target.runtimeHomePath)) {
    return null
  }
  const install =
    args.install ??
    ((home: string, hookTarget: CodexWslRuntimeHookTarget) =>
      codexHookService.installForRuntimeHomeSerialized(home, hookTarget))
  return await install(target.runtimeHomePath, {
    runtime: 'wsl',
    wslDistro: target.wslDistro
  })
}
