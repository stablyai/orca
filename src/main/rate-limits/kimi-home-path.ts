import { win32 as pathWin32 } from 'node:path'
import type { GlobalSettings } from '../../shared/types'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { getDefaultWslDistro, getWslHome } from '../wsl'

export type KimiHomePathResolution = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
  // Why: null on host (the fetcher keeps its KIMI_CODE_HOME / ~/.kimi-code
  // default) and when the WSL distro home cannot be resolved.
  homePath: string | null
}

type KimiHomePathSettings = Pick<
  GlobalSettings,
  'localAccountRuntime' | 'localAccountWslDistro' | 'localWindowsRuntimeDefault'
>

/**
 * Resolve the Kimi credentials home for the configured local-account runtime
 * target, mirroring how Codex resolves its WSL home: the distro comes from the
 * persisted target (falling back to the default distro) and the Linux home from
 * the cached `echo $HOME` probe, read over its UNC path — never via wsl.exe.
 */
export function resolveKimiHomePath(
  settings: KimiHomePathSettings,
  platform: NodeJS.Platform = process.platform
): KimiHomePathResolution {
  const target = resolveLocalAccountRuntimeTarget(settings, platform)
  // Why: an explicit 'wsl' policy only makes sense on Windows hosts; elsewhere
  // resolveLocalAccountRuntimeTarget still returns it, so pin to host like
  // getInitialCodexRateLimitTarget does.
  if (target.runtime !== 'wsl' || platform !== 'win32') {
    return { runtime: 'host', wslDistro: null, homePath: null }
  }
  const distro = target.wslDistro ?? getDefaultWslDistro()
  const home = distro ? getWslHome(distro) : null
  return {
    runtime: 'wsl',
    wslDistro: distro,
    homePath: home ? pathWin32.join(home, '.kimi-code') : null
  }
}
