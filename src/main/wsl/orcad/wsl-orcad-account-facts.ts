/** The Linux account a WSL host runs as, its orcad key, and any other account's orcad in the distro (#49180). */
import { OrcadHostUnsupportedError } from '../../orcad/diagnostics/orcad-host-unavailable'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { pinnedWslHostLinuxUser } from './wsl-orcad-host-user'
import { orcadPublicKeyCommand } from '../host-lifecycle/wsl-host-ssh-orcad-conflict'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const USER_MARKER = '__ORCA_WSL_USER__ '
const KEY_MARKER = '__ORCA_WSL_KEY__ '
const PEER_MARKER = '__ORCA_WSL_PEER__ '
// Every managed orcad's argv names its entry this way; the probe's own argv runs as this account.
const ORCAD_ARGV = '/orcad.js --json --bind '

/** Test seam: where the probe reads the process list. */
type FactsSources = { processes: string }

/** Account and key lines, then the first other account running a managed orcad here, if any. */
export function wslAccountFactsCommand(
  sources: FactsSources = { processes: 'ps -eo uid=,args= 2>/dev/null' }
): string {
  return [
    `_orca_me=$(id -u); printf '${USER_MARKER}%s %s\\n' "$_orca_me" "$(id -un 2>/dev/null)";`,
    `printf '${KEY_MARKER}%s\\n' "$(${orcadPublicKeyCommand('$HOME')})";`,
    `_orca_peer=$(${sources.processes} | awk -v me="$_orca_me" '$1 != me && index($0, "${ORCAD_ARGV}") { print $1; exit }');`,
    `printf '${PEER_MARKER}%s %s\\n' "$_orca_peer" "$([ -n "$_orca_peer" ] && getent passwd "$_orca_peer" | cut -d: -f1)"`
  ].join(' ')
}

export const WSL_ACCOUNT_FACTS_COMMAND = wslAccountFactsCommand()

/** `name` is null when the account has no passwd entry, so nothing may pin it. */
export type WslLinuxAccount = { uid: string; name: string | null }

export type WslAccountFacts = {
  account?: WslLinuxAccount
  /** This account's orcad host key, or null when it has none yet. */
  ownKey?: string | null
  /** Another account whose managed orcad also runs in this distro (on its own port). */
  otherServerAccount?: WslLinuxAccount
}

function readAccount(line: string, marker: string): WslLinuxAccount | null | undefined {
  if (!line.startsWith(marker)) {
    return undefined
  }
  const [uid = '', name = ''] = line.slice(marker.length).trim().split(/\s+/)
  return /^\d+$/.test(uid) ? { uid, name: name || null } : null
}

/** Null when the lines aren't the command's two lines; otherwise whatever they proved. */
export function readWslAccountFacts(
  userLine: string,
  keyLine: string,
  peerLine: string
): WslAccountFacts | null {
  const account = readAccount(userLine, USER_MARKER)
  const peer = readAccount(peerLine, PEER_MARKER)
  if (account === undefined || peer === undefined || !keyLine.startsWith(KEY_MARKER)) {
    return null
  }
  const ownKey = keyLine.slice(KEY_MARKER.length).trim() || null
  return {
    ...(account ? { account, ownKey } : {}),
    ...(peer && peer.uid !== account?.uid ? { otherServerAccount: peer } : {})
  }
}

const warnedPeers = new Set<string>()

/** Each account's orcad binds its own port, so they coexist; say once that two run here. */
export function noteWslOtherAccountServer(distro: string, other: WslLinuxAccount): void {
  const key = `${distro}\0${other.uid}`
  if (!warnedPeers.has(key)) {
    warnedPeers.add(key)
    console.warn(
      `[wsl-hosts] ${distro} also runs Orca’s server for the Linux user ${accountName(other)}; this host keeps its own account’s server and port.`
    )
  }
}

/** The distro's default account when the host is pinned to another; null when it's the same or unread. */
export async function readWslDefaultUserBesidePin(
  target: WslOrcadHostTarget,
  signal: AbortSignal
): Promise<string | null> {
  const pinned = pinnedWslHostLinuxUser(target.distro)
  if (!pinned) {
    return null
  }
  // Its own wsl.exe, unpinned: only the default user's shell can say who that is.
  const transport = createWslOrcadHostTransport({ target, user: null, commandLoops: false, signal })
  try {
    const name = (await execCommand(transport, 'id -un', { signal })).trim()
    return name && name !== pinned ? name : null
  } catch {
    return null
  } finally {
    transport.dispose()
  }
}

function accountName(account: WslLinuxAccount): string {
  return account.name ?? `uid ${account.uid}`
}

/** Final until the user's Connect: an unpinned host's default account isn't the paired server's. */
export class WslHostAccountChangedError extends OrcadHostUnsupportedError {
  readonly code = 'wsl_host_account_changed'
  constructor(
    readonly distro: string,
    readonly account: WslLinuxAccount
  ) {
    // Neutral: a reset identity looks the same; only Connect's search can tell the user changed.
    super(
      `The Orca server for ${distro}’s default Linux user (${accountName(account)}) isn’t the one ` +
        'this desktop paired with. Click Connect to look for it under the distro’s other Linux ' +
        'users, or remove the WSL host and add it again to use this one.'
    )
    this.name = 'WslHostAccountChangedError'
  }
}

/** Final: no Linux user in the distro holds the paired server, so only a fresh Add helps. */
export class WslHostPairedAccountMissingError extends OrcadHostUnsupportedError {
  readonly code = 'wsl_host_paired_account_missing'
  constructor(distro: string) {
    super(
      `No Linux user in ${distro} runs the Orca server this desktop paired with (it was ` +
        'reinstalled, its identity was reset, or Orca couldn’t look as root). Remove the WSL host ' +
        'and add it again.'
    )
    this.name = 'WslHostPairedAccountMissingError'
  }
}
