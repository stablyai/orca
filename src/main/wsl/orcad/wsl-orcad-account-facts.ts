/**
 * Which Linux account a WSL host's commands run as, and whether another account already runs a
 * managed orcad in the distro (#49180). Two accounts' servers share the distro's loopback ports,
 * so the second one would take another port and its desktop would pair with a stranger.
 */
const USER_MARKER = '__ORCA_WSL_USER__ '
const PEER_MARKER = '__ORCA_WSL_PEER__ '
// Every managed orcad's argv names its entry this way; the probe's own argv runs as this account.
const ORCAD_ARGV = '/orcad.js --json --bind '

/** Prints this account's line, then the other account's (or an empty one); one ps for the scan. */
export const WSL_ACCOUNT_FACTS_COMMAND = [
  `_orca_me=$(id -u); printf '${USER_MARKER}%s %s\\n' "$_orca_me" "$(id -un)";`,
  `_orca_peer=$(ps -eo uid=,args= 2>/dev/null | awk -v me="$_orca_me" '$1 != me && index($0, "${ORCAD_ARGV}") { print $1; exit }');`,
  `printf '${PEER_MARKER}%s %s\\n' "$_orca_peer" "$([ -n "$_orca_peer" ] && getent passwd "$_orca_peer" | cut -d: -f1)"`
].join(' ')

/** `name` is null when the account has no passwd entry, so nothing may pin it. */
export type WslLinuxAccount = { uid: string; name: string | null }

export type WslAccountFacts = {
  account?: WslLinuxAccount
  /** Another account whose managed orcad already runs in this distro. */
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
export function readWslAccountFacts(userLine: string, peerLine: string): WslAccountFacts | null {
  const account = readAccount(userLine, USER_MARKER)
  const peer = readAccount(peerLine, PEER_MARKER)
  if (account === undefined || peer === undefined) {
    return null
  }
  return {
    ...(account ? { account } : {}),
    ...(peer && peer.uid !== account?.uid ? { otherServerAccount: peer } : {})
  }
}

/** A second managed orcad would run beside another account's: refuse instead of pairing with it. */
export class WslOrcadOtherAccountServerError extends Error {
  readonly code = 'wsl_orcad_other_account_server'
  constructor(distro: string, other: WslLinuxAccount, account: WslLinuxAccount | undefined) {
    const otherName = other.name ?? `uid ${other.uid}`
    const self = account ? ` as ${account.name ?? `uid ${account.uid}`}` : ''
    super(
      `Orca’s server is already running in ${distro} for the Linux user ${otherName} (uid ${other.uid}), ` +
        `so Orca won’t start a second one${self} that would compete for its port. Stop that server ` +
        `(for example with \`wsl.exe --terminate ${distro}\`), or remove this WSL host and add it ` +
        `again while ${otherName} is the distro’s default user.`
    )
    this.name = 'WslOrcadOtherAccountServerError'
  }
}
