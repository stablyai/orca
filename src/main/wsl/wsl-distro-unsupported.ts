/**
 * Distros that can't host Orca's server, each refused with the step that fixes it. There is no
 * fallback once the WSL bridge is gone, so a refusal must say what to run, not only what failed.
 */
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import { OrcadHostGlibcUnsupportedError } from '../managed-server/lifecycle/orcad-runtime-target'
import { RemoteNodeRuntimeSelfTestError } from '../ssh/orcad-remote-node-runtime-report'
import { wslHostAddRefusalText } from '../../shared/wsl-host-failure-copy'

/** Keeps OrcadHostUnsupportedError's name, so callers that classify by name still see it. */
export class WslDistroVersion1Error extends OrcadHostUnsupportedError {
  constructor(readonly distro: string) {
    super(wslHostAddRefusalText('wsl1', { distro }).text)
  }
}

export class WslDistroNotRegisteredError extends OrcadHostUnsupportedError {
  constructor(readonly distro: string) {
    super(wslHostAddRefusalText('notRegistered', { distro }).text)
  }
}

// wsl.exe localizes its sentence but not the error code that newer builds print after it.
const DISTRO_NOT_FOUND = /WSL_E_DISTRO_NOT_FOUND|There is no distribution with the supplied name/i

export function isWslDistroNotFoundFailure(error: unknown): boolean {
  return error instanceof Error && DISTRO_NOT_FOUND.test(error.message)
}

/** Rethrows wsl.exe's missing-distro failure as the refusal that says how to fix it. */
export function refuseMissingWslDistro(distro: string): (error: unknown) => never {
  return (error) => {
    throw isWslDistroNotFoundFailure(error) ? new WslDistroNotRegisteredError(distro) : error
  }
}

// NixOS's stub loader refuses generic Linux binaries with this sentence.
const NIXOS_STUB_LOADER = /NixOS cannot run dynamically linked executables/

/** The shared server refusal plus the step that fixes it in a distro; null when there is none. */
export function wslUnsupportedDistroFixMessage(error: unknown): string | null {
  if (error instanceof OrcadHostGlibcUnsupportedError) {
    return (
      `${error.message} Use a Linux release with glibc 2.28 or newer ` +
      '(for example Ubuntu 20.04 or Debian 10 and later).'
    )
  }
  if (error instanceof RemoteNodeRuntimeSelfTestError && NIXOS_STUB_LOADER.test(error.output)) {
    return (
      'NixOS can’t run Orca’s Node runtime as it is. Turn on nix-ld ' +
      '(programs.nix-ld.enable = true; in configuration.nix), run nixos-rebuild switch, ' +
      `then reconnect. (exit ${error.exitStatus ?? 'unknown'}: ${error.output})`
    )
  }
  return null
}
