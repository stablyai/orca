/** Probe this endpoint only: unlinking a refusing live socket strands its relay/PTYs (#8585). Exit requires refused connect, complete no-holder evidence and local storage; shared-home sockets may live on another kernel. Missing tools or ambiguous failures stay unverifiable and never authorize cleanup (docs/reference/ssh-execution-boundary.md). */
import { RELAY_LSOF_PROBE_JS } from '@orca/process-host/posix-lsof-probe'
import type { SshConnection } from '../connection/ssh-connection'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  RELAY_CHILD_COUNT_VAR,
  RELAY_UNRECOGNIZED_CHILD_COUNT_VAR,
  relayDaemonChildCensusShell
} from '../relay-daemon-service-children'
import { execCommand, isUnconfirmedSshCommandTermination } from '../remote-exec/remote-exec-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../ssh-remote-platform'
import { filesystemTypeIsLocalDisk } from '../../orcad/orcad-data-root-locality'

type RelayEndpointVerdict = 'live' | 'unverifiable' | 'exited'

type RelayEndpointEvidence = 'accepted-connection' | 'holder-process' | 'no-holder' | 'inconclusive'

type RelayEndpointHolder = {
  pid: number
  /** The holder's argv names relay.js AND this exact socket path. */
  matchesRelayArgv: boolean
  /** Direct children, or null when `pgrep` could not answer. Never guessed. */
  childCount: number | null
  /** Exclude only proven daemon service children; null means incomplete enumeration (relay-daemon-service-children.ts). */
  unrecognizedChildCount: number | null
}

export type RelayEndpointIncumbent = {
  sockPath: string
  verdict: RelayEndpointVerdict
  evidence: RelayEndpointEvidence
  socketPresent: boolean
  /** Pids observed holding this socket, including partial enumeration results. */
  holders: RelayEndpointHolder[]
  /** False when enumeration was incomplete — an empty `holders` then proves nothing. */
  holdersEnumerable: boolean
}

const PROBE_BEGIN = 'ORCA-INCUMBENT-BEGIN'
const PROBE_END = 'ORCA-INCUMBENT-END'
const CONNECT_PROBE_TIMEOUT_MS = 1000

// Use ES5 for host-provided Node runtimes.
const RELAY_CONNECT_PROBE_JS = [
  'var s=require("net").connect(process.argv[1]);',
  'var done=false;',
  'function say(v){if(done)return;done=true;try{s.destroy()}catch(e){};',
  'process.stdout.write(v);process.exit(0)}',
  's.on("connect",function(){say("accepted")});',
  's.on("error",function(e){',
  'say(e.code==="ECONNREFUSED"?"refused":e.code==="ENOENT"?"absent":"unknown")});',
  `setTimeout(function(){say("unknown")},${CONNECT_PROBE_TIMEOUT_MS})`
].join('')

// `<platform> <hex f_type of the socket's directory> <hex f_type of />`; old Nodes lack statfsSync.
const ENDPOINT_FILESYSTEM_PROBE_JS = [
  'var f=require("fs");',
  'var a=f.statfsSync(process.argv[1]).type>>>0,b=f.statfsSync("/").type>>>0;',
  'process.stdout.write(process.platform+" "+a.toString(16)+" "+b.toString(16))'
].join('')

// `/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)` → `apfs`.
const DARWIN_MOUNT_TYPE_AWK =
  '{i=index($0," on "mp" (");if(i&&mp!=""){t=substr($0,i+length(mp)+6);sub(/[,)].*/,"",t);print t;exit}}'
// Only these macOS filesystems live on a disk this machine owns.
const DARWIN_LOCAL_FILESYSTEM_NAMES = new Set(['apfs', 'hfs'])

class RelayProbeCleanupUnconfirmedError extends Error {
  readonly name = 'RelayProbeCleanupUnconfirmedError'
  constructor() {
    super('Remote relay probe cleanup is unverifiable; refusing to race a replacement launch')
  }
}

/** Keep every unknown explicit; missing tools must never imply absence. */
export function relayEndpointIncumbentProbeCommand(nodePath: string, sockPath: string): string {
  const sock = quotePosixShell(sockPath)
  const node = quotePosixShell(nodePath)
  return [
    `sock=${sock}`,
    `node=${node}`,
    `printf '%s\\n' ${quotePosixShell(PROBE_BEGIN)}`,
    'if [ -S "$sock" ]; then',
    "  printf 'PRESENT=yes\\n'",
    `  listen=$("$node" -e ${quotePosixShell(RELAY_CONNECT_PROBE_JS)} "$sock" 2>/dev/null) || listen=unknown`,
    '  [ -n "$listen" ] || listen=unknown',
    'else',
    "  printf 'PRESENT=no\\n'",
    '  listen=absent',
    'fi',
    'printf \'LISTEN=%s\\n\' "$listen"',
    'dir=$(dirname "$sock")',
    `fs_type=$("$node" -e ${quotePosixShell(ENDPOINT_FILESYSTEM_PROBE_JS)} "$dir" 2>/dev/null) || fs_type=`,
    'if [ -n "$fs_type" ]; then :',
    // BSD stat has no filesystem type; macOS names it in `mount` against df's mount point.
    'elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then',
    `  mp=$(df -P "$dir" 2>/dev/null | awk 'NR==2{print $NF}')`,
    `  fs_type="darwin-mount $(mount 2>/dev/null | awk -v mp="$mp" ${quotePosixShell(DARWIN_MOUNT_TYPE_AWK)})"`,
    'else',
    '  fs_type="$(uname -s 2>/dev/null) $(stat -f -c %t "$dir" 2>/dev/null) $(stat -f -c %t / 2>/dev/null)"',
    'fi',
    'printf \'FS_TYPE=%s\\n\' "$fs_type"',
    'if command -v lsof >/dev/null 2>&1; then',
    // Why -a: lsof ORs selectors without it and reports unrelated unix-socket holders (#8762).
    `  lsof_result=$("$node" -e ${quotePosixShell(RELAY_LSOF_PROBE_JS)} "$sock" 2>/dev/null) || lsof_result=unavailable`,
    '  case "$lsof_result" in',
    '    cleanup-unconfirmed*)',
    "      printf 'PROBE_CLEANUP=unconfirmed\\n'",
    "      printf 'HOLDERS_SOURCE=unavailable\\n'",
    '      ;;',
    '    lsof*)',
    "      printf 'HOLDERS_SOURCE=lsof\\n'",
    '      ;;',
    '    *)',
    "      printf 'HOLDERS_SOURCE=unavailable\\n'",
    '      ;;',
    '  esac',
    "  pids=$(printf '%s\\n' \"$lsof_result\" | sed '1d')",
    '  for pid in $pids; do',
    '    args=$(ps -o args= -p "$pid" 2>/dev/null | tr "\\n" " ")',
    '    match=no',
    '    case "$args" in *relay.js*"$sock"*) match=yes ;; esac',
    ...relayDaemonChildCensusShell().map((line) => `    ${line}`),
    '    printf \'HOLDER=%s %s %s %s\\n\' "$pid" "$match" ' +
      `"$${RELAY_CHILD_COUNT_VAR}" "$${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}"`,
    '  done',
    'else',
    "  printf 'HOLDERS_SOURCE=unavailable\\n'",
    'fi',
    `printf '%s\\n' ${quotePosixShell(PROBE_END)}`
  ].join('\n')
}

export function parseRelayEndpointIncumbentProbe(
  sockPath: string,
  output: string
): RelayEndpointIncumbent {
  const lines = output.split('\n').map((line) => line.trim())
  if (!lines.includes(PROBE_BEGIN) || !lines.includes(PROBE_END)) {
    return unverifiableEndpoint(sockPath)
  }
  if (lines.includes('PROBE_CLEANUP=unconfirmed')) {
    throw new RelayProbeCleanupUnconfirmedError()
  }
  const socketPresent = lines.includes('PRESENT=yes')
  const listen = lines.find((line) => line.startsWith('LISTEN='))?.slice('LISTEN='.length) ?? ''
  const holdersEnumerable = lines.includes('HOLDERS_SOURCE=lsof')
  const holders = lines
    .filter((line) => line.startsWith('HOLDER='))
    .map((line) => parseHolder(line.slice('HOLDER='.length)))
    .filter((holder): holder is RelayEndpointHolder => holder !== null)

  if (listen === 'accepted') {
    return {
      sockPath,
      verdict: 'live',
      evidence: 'accepted-connection',
      socketPresent,
      holders,
      holdersEnumerable
    }
  }
  if (holders.length > 0) {
    // A held inode with refused connect is wedged, not exited.
    return {
      sockPath,
      verdict: 'live',
      evidence: 'holder-process',
      socketPresent,
      holders,
      holdersEnumerable
    }
  }
  const fsType = lines.find((line) => line.startsWith('FS_TYPE='))?.slice('FS_TYPE='.length)
  if (
    holdersEnumerable &&
    (listen === 'absent' || (listen === 'refused' && endpointIsOnLocalDisk(fsType)))
  ) {
    return {
      sockPath,
      verdict: 'exited',
      evidence: 'no-holder',
      socketPresent,
      holders,
      holdersEnumerable
    }
  }
  return { ...unverifiableEndpoint(sockPath), socketPresent, holders, holdersEnumerable }
}

/** Unknown or unreadable types are not local: only a local disk confines a socket to this kernel. */
function endpointIsOnLocalDisk(fsType: string | undefined): boolean {
  const [platform, rawType, rawRootType] = (fsType ?? '').trim().split(/\s+/)
  if (platform === 'darwin-mount') {
    return DARWIN_LOCAL_FILESYSTEM_NAMES.has(rawType ?? '')
  }
  const parseType = (raw: string | undefined): number | null =>
    raw && /^[0-9a-f]{1,8}$/iu.test(raw) ? Number.parseInt(raw, 16) : null
  const type = parseType(rawType)
  return (
    type !== null &&
    filesystemTypeIsLocalDisk((platform ?? '').toLowerCase(), type, () => parseType(rawRootType))
  )
}

function parseHolder(value: string): RelayEndpointHolder | null {
  const [rawPid, rawMatch, rawKids, rawUnrecognized] = value.split(/\s+/)
  const pid = Number.parseInt(rawPid ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  return {
    pid,
    matchesRelayArgv: rawMatch === 'yes',
    childCount: parseChildCount(rawKids),
    unrecognizedChildCount: parseChildCount(rawUnrecognized)
  }
}

/** Unknown, absent and malformed counts must never become zero. */
function parseChildCount(raw: string | undefined): number | null {
  const count = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(count) && count >= 0 ? count : null
}

function unverifiableEndpoint(sockPath: string): RelayEndpointIncumbent {
  return {
    sockPath,
    verdict: 'unverifiable',
    evidence: 'inconclusive',
    socketPresent: false,
    holders: [],
    holdersEnumerable: false
  }
}

export async function probeRelayEndpointIncumbent(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  sockPath: string,
  options?: { signal?: AbortSignal }
): Promise<RelayEndpointIncumbent> {
  // Windows pipes cannot be orphaned by unlink; this POSIX probe cannot classify them.
  if (isWindowsRemoteHost(hostPlatform)) {
    return unverifiableEndpoint(sockPath)
  }
  try {
    const output = await execCommand(conn, relayEndpointIncumbentProbeCommand(nodePath, sockPath), {
      wrapCommand: true,
      signal: options?.signal
    })
    return parseRelayEndpointIncumbentProbe(sockPath, output)
  } catch (err) {
    // Unconfirmed channel cleanup may leave the probe running remotely; do not race it with launch.
    if (
      err instanceof RelayProbeCleanupUnconfirmedError ||
      isUnconfirmedSshCommandTermination(err)
    ) {
      throw err
    }
    // Unanswered probes never prove exit.
    return unverifiableEndpoint(sockPath)
  }
}

/** Reap only one argv-verified relay holder with complete enumeration and no unrecognized children. childCount===0 would exclude idle relays whose AI Vault sidecar persists (#13614). */
export function isReapableRelayHusk(incumbent: RelayEndpointIncumbent): boolean {
  if (incumbent.verdict !== 'live' || !incumbent.holdersEnumerable) {
    return false
  }
  if (incumbent.holders.length !== 1) {
    return false
  }
  const [holder] = incumbent.holders
  return holder.matchesRelayArgv && holder.unrecognizedChildCount === 0
}
