/** Why a distro cannot be added as a WSL host, decided before anything runs in it. */
import type { WslHostAddResult } from '../../shared/wsl-host-types'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import { wslDistroHolderKey } from './wsl-distro-holder-record'

export const WSL_HOSTS_DISABLED_MESSAGE = 'WSL hosts are turned off in Settings → Experimental.'
export const WSL_HOST_SERVER_FILES_MISSING_MESSAGE =
  'This build of Orca can’t run WSL hosts (server files missing).'

type WslHostAddRefusal = Extract<WslHostAddResult, { ok: false }>

export const WSL_HOST_REMOVING_MESSAGE = 'This WSL host is being removed.'

export function wslHostNotConnectedMessage(distro: string): string {
  return `The WSL host ${distro} isn’t connected. Open one of its projects or connect it in Settings → Remote Orca Servers.`
}

export function wslHostStoppedMessage(distro: string): string {
  return `${distro} was stopped. Switch to one of its projects, or reconnect it in Settings → Remote Orca Servers, to start it again.`
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
    return { ok: false, kind: 'disabled', message: WSL_HOSTS_DISABLED_MESSAGE }
  }
  // Reject missing packaged templates before C4 deploy emits an opaque deep failure.
  return gate.hasServerFiles()
    ? null
    : { ok: false, kind: 'server-files-missing', message: WSL_HOST_SERVER_FILES_MISSING_MESSAGE }
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
    return {
      ok: false,
      kind: 'failed',
      message: `${args.requested} is not a registered WSL distro.`
    }
  }
  if (distro.version === 1) {
    return {
      ok: false,
      kind: 'unsupported-wsl1',
      message: `${distro.name} runs WSL 1, which isn’t supported as a host. Convert it with: wsl --set-version ${distro.name} 2`
    }
  }
  if (args.alreadyAdded(distro.name)) {
    return { ok: false, kind: 'already-added', message: `${distro.name} is already a host.` }
  }
  if (distro.state === 'stopped' && !args.startIfStopped) {
    return {
      ok: false,
      kind: 'distro-stopped',
      message: `${distro.name} stopped since the list was read. Choose Start and add to start it.`
    }
  }
  return { distro }
}
