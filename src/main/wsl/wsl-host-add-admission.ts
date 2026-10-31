/** Why a distro cannot be added as a WSL host, decided before anything runs in it. */
import type { WslHostAddFailureKind, WslHostAddResult } from '../../shared/wsl-host-types'
import {
  WSL_HOST_ADD_REFUSAL_COPY,
  wslHostAddRefusalText,
  type WslHostAddRefusalCode,
  type WslHostCopyParams
} from '../../shared/wsl-host-failure-copy'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { wslDistroHolderKey } from './wsl-distro-holder-record'

export const WSL_HOSTS_DISABLED_MESSAGE = WSL_HOST_ADD_REFUSAL_COPY.turnedOff
export const WSL_HOST_SERVER_FILES_MISSING_MESSAGE = WSL_HOST_ADD_REFUSAL_COPY.serverFilesMissing

type WslHostAddRefusal = Extract<WslHostAddResult, { ok: false }>

/** A refusal whose English `message` and translation code come from one table. */
export function wslHostAddRefusal(
  kind: WslHostAddFailureKind,
  code: WslHostAddRefusalCode,
  params?: WslHostCopyParams
): WslHostAddRefusal {
  const { text, code: errorCode, params: errorParams } = wslHostAddRefusalText(code, params)
  return { ok: false, kind, message: text, errorCode, ...(errorParams ? { errorParams } : {}) }
}

export const WSL_HOST_REMOVING_MESSAGE = 'This WSL host is being removed.'

export function wslHostNotConnectedMessage(distro: string): string {
  return `The WSL host ${distro} isn’t connected. Open one of its projects or connect it in Settings → Remote Orca Servers.`
}

export function wslHostStoppedMessage(distro: string): string {
  return `${distro} was stopped. Switch to one of its projects, or reconnect it in Settings → Remote Orca Servers, to start it again.`
}

/** Shown on a paired phone once a stop is confirmed: only the desktop starts a distro. */
export function wslHostStoppedForPhoneMessage(distro: string): string {
  return `The WSL host ${distro} isn’t running. Open one of its projects on your computer to start it.`
}

/** Shown on a paired phone while WSL hosts are switched off, or this one is being removed. */
export function wslHostHiddenFromPhoneMessage(distro: string): string {
  return `The WSL host ${distro} is turned off or being removed on your computer.`
}

/** Shown on a paired phone while the desktop can't confirm the host runs (starting, reconnecting). */
export function wslHostUnavailableForPhoneMessage(distro: string): string {
  return `The WSL host ${distro} isn’t available from your phone right now. Open one of its projects on your computer to connect it.`
}

export function wslHostRemovalPendingMessage(distro: string): string {
  return `Orca didn’t finish removing the WSL host ${distro}. Remove it again in Settings → Remote Orca Servers, or connect it to keep it.`
}

/** Why no WSL host may run at all right now; null when they may. */
export function wslHostRunRefusal(gate: {
  isEnabled: () => boolean
  hasServerFiles: () => boolean
}): WslHostAddRefusal | null {
  if (!gate.isEnabled()) {
    return wslHostAddRefusal('disabled', 'turnedOff')
  }
  // Reject missing packaged templates before C4 deploy emits an opaque deep failure.
  return gate.hasServerFiles()
    ? null
    : wslHostAddRefusal('server-files-missing', 'serverFilesMissing')
}

export function sameWslDistro(left: string, right: string): boolean {
  return wslDistroHolderKey(left) === wslDistroHolderKey(right)
}

/** The candidate to add, or why not; a stopped distro needs the user's explicit start. */
export function admitWslHostDistro(args: {
  requested: string
  candidates: readonly WslHostDistroCandidate[]
  alreadyAdded: (distro: string) => boolean
  startIfStopped: boolean
}): { distro: WslHostDistroCandidate } | WslHostAddRefusal {
  const distro = args.candidates.find((candidate) => sameWslDistro(candidate.name, args.requested))
  if (!distro) {
    return wslHostAddRefusal('failed', 'notRegistered', { distro: args.requested })
  }
  if (distro.version === 1) {
    return wslHostAddRefusal('unsupported-wsl1', 'wsl1', { distro: distro.name })
  }
  if (args.alreadyAdded(distro.name)) {
    return wslHostAddRefusal('already-added', 'alreadyAdded', { distro: distro.name })
  }
  if (distro.state === 'stopped' && !args.startIfStopped) {
    return wslHostAddRefusal('distro-stopped', 'distroStopped', { distro: distro.name })
  }
  return { distro }
}
