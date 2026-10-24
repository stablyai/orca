/**
 * Distros that can't host Orca's server, each refused with the step that fixes it. There is no
 * fallback once the WSL bridge is gone, so a refusal must say what to run, not only what failed.
 */
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'

export function wsl1DistroMessage(distro: string): string {
  return (
    `${distro} runs WSL 1, which Orca no longer supports. ` +
    `Convert it to WSL 2 in a Windows terminal with: wsl --set-version ${distro} 2`
  )
}

export function wslDistroNotRegisteredMessage(distro: string): string {
  return (
    `${distro} is not an installed WSL distro. ` +
    'Run wsl --list --verbose in a Windows terminal to see the installed ones, ' +
    'or reinstall it and try again.'
  )
}

/** Keeps OrcadHostUnsupportedError's name, so callers that classify by name still see it. */
export class WslDistroVersion1Error extends OrcadHostUnsupportedError {
  constructor(distro: string) {
    super(wsl1DistroMessage(distro))
  }
}

export class WslDistroNotRegisteredError extends OrcadHostUnsupportedError {
  constructor(distro: string) {
    super(wslDistroNotRegisteredMessage(distro))
  }
}

// wsl.exe localizes its sentence but not the error code that newer builds print after it.
const DISTRO_NOT_FOUND = /WSL_E_DISTRO_NOT_FOUND|There is no distribution with the supplied name/i

export function isWslDistroNotFoundFailure(error: unknown): boolean {
  return error instanceof Error && DISTRO_NOT_FOUND.test(error.message)
}
