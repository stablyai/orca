/** The Linux account a WSL host runs as, and whether another account's orcad holds its port (#49180). */
import { ORCAD_MANAGED_REMOTE_PORT } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
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
const UNAVAILABLE = '?'

type FactsSources = { processes: string; tcpFiles: readonly string[] }

const LIVE_SOURCES: FactsSources = {
  processes: 'ps -eo uid=,args= 2>/dev/null',
  tcpFiles: ['/proc/net/tcp', '/proc/net/tcp6']
}

/** Account, key and peer lines; the peer must own both the port's listener and an orcad process, since WSL2 distros share one network. */
export function wslAccountFactsCommand(
  sources: FactsSources = LIVE_SOURCES,
  port = ORCAD_MANAGED_REMOTE_PORT
): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const files = sources.tcpFiles.map((file) => `'${file}'`).join(' ')
  return [
    `_orca_me=$(id -u); printf '${USER_MARKER}%s %s\\n' "$_orca_me" "$(id -un 2>/dev/null)";`,
    `printf '${KEY_MARKER}%s\\n' "$(${orcadPublicKeyCommand('$HOME')})";`,
    `_orca_tcp=; for _orca_f in ${files}; do [ -r "$_orca_f" ] && _orca_tcp="$_orca_tcp $_orca_f"; done;`,
    `_orca_ps=$(${sources.processes});`,
    `if [ -z "$_orca_ps" ] || [ -z "$_orca_tcp" ]; then _orca_peer='${UNAVAILABLE}'; else`,
    `_orca_peer=$(printf '%s\\n' "$_orca_ps" | awk -v me="$_orca_me" 'FILENAME ~ /^\\// { if ($4 == "0A" && toupper($2) ~ /:${hexPort}$/) port[$8] = 1; next } $1 != me && ($1 in port) && index($0, "${ORCAD_ARGV}") { print $1; exit }' $_orca_tcp -); fi;`,
    `printf '${PEER_MARKER}%s %s\\n' "$_orca_peer" "$(case $_orca_peer in (''|'${UNAVAILABLE}') ;; (*) getent passwd "$_orca_peer" | cut -d: -f1 ;; esac)"`
  ].join(' ')
}

export const WSL_ACCOUNT_FACTS_COMMAND = wslAccountFactsCommand()

/** `name` is null when the account has no passwd entry, so nothing may pin it. */
export type WslLinuxAccount = { uid: string; name: string | null }

export type WslAccountFacts = {
  account?: WslLinuxAccount
  /** This account's orcad host key, or null when it has none yet. */
  ownKey?: string | null
  /** Another account whose managed orcad holds this host's port. */
  otherServerAccount?: WslLinuxAccount
  /** ps or the socket tables were unreadable, so the port check was skipped. */
  portCheckUnavailable?: true
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
  const unavailable = peerLine.slice(PEER_MARKER.length).trim().startsWith(UNAVAILABLE)
  return {
    ...(account ? { account, ownKey } : {}),
    ...(peer && peer.uid !== account?.uid ? { otherServerAccount: peer } : {}),
    ...(unavailable ? { portCheckUnavailable: true as const } : {})
  }
}

const warnedUnavailable = new Set<string>()

/** Fails open without ps or /proc/net, as before the check; says so once per distro. */
export function noteWslPortCheckUnavailable(distro: string): void {
  if (!warnedUnavailable.has(distro)) {
    warnedUnavailable.add(distro)
    console.warn(
      `[wsl-hosts] Couldn’t check which Linux account holds Orca’s port in ${distro} (ps or /proc/net unreadable).`
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

/** Final: retrying can't free the port, so the connect waits on the user (never liveness). */
export class WslOrcadOtherAccountServerError extends OrcadHostUnsupportedError {
  readonly code = 'wsl_orcad_other_account_server'
  readonly port = ORCAD_MANAGED_REMOTE_PORT
  constructor(
    readonly distro: string,
    readonly other: WslLinuxAccount,
    account: WslLinuxAccount | undefined
  ) {
    const self = account ? ` as ${accountName(account)}` : ''
    super(
      `Port ${ORCAD_MANAGED_REMOTE_PORT} in ${distro} is held by Orca’s server for the Linux user ` +
        `${accountName(other)}, so Orca can’t run this host’s server${self}. Remove the WSL host ` +
        `that runs as ${accountName(other)} in the Orca that added it, or end that server as ` +
        `${accountName(other)} (\`wsl.exe -d ${distro} -u ${other.name ?? 'root'} pkill -f /orcad.js\`).`
    )
    this.name = 'WslOrcadOtherAccountServerError'
  }
}

/** Final until the user's Connect: an unpinned host's default account isn't the paired server's. */
export class WslHostAccountChangedError extends OrcadHostUnsupportedError {
  readonly code = 'wsl_host_account_changed'
  constructor(
    readonly distro: string,
    readonly account: WslLinuxAccount
  ) {
    super(
      `${distro}’s default Linux user is now ${accountName(account)}, which isn’t the account ` +
        'this host’s Orca server runs as. Click Connect to find that account and keep using it; ' +
        'to switch to the new user, remove the WSL host and add it again.'
    )
    this.name = 'WslHostAccountChangedError'
  }
}
