/**
 * Who currently owns a relay socket path, answered with host evidence.
 *
 * The client used to answer this by assumption: a failed `--connect` was read as "the relay
 * crashed", the socket was `rm -f`'d, and a fresh relay bound the same path. Unlinking a unix
 * socket does not close the listener the incumbent already holds, so an alive-but-refusing
 * relay (the `RelayVersionMismatchError` case, and the credential-rotation case) was left
 * running forever with its PTYs (#8585).
 *
 * The verdict vocabulary is fixed by docs/reference/ssh-execution-boundary.md — `live` /
 * `unverifiable` / `exited`, with no synonyms and no collapsing. Two consequences are load
 * bearing here:
 *
 * - `exited` is a claim about **this endpoint**, not about every relay on the host. It means
 *   nothing holds this socket path, established positively (a connect that was refused *and*
 *   an enumeration that found no holder). A relay whose socket was already unlinked is
 *   invisible to this probe by construction.
 * - a probe that could not run, a host without `lsof`, or a connect that failed for any other
 *   reason is `unverifiable`. It never authorizes client cleanup.
 * - a refused socket is `exited` only on a local disk. On a network home another machine's
 *   kernel may hold it, and this machine's connect and `lsof` cannot see that machine.
 */
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

export type RelayEndpointEvidence =
  | 'accepted-connection'
  | 'holder-process'
  | 'no-holder'
  | 'inconclusive'

export type RelayEndpointHolder = {
  pid: number
  /** The holder's argv names relay.js AND this exact socket path. */
  matchesRelayArgv: boolean
  /** Direct children, or null when `pgrep` could not answer. Never guessed. */
  childCount: number | null
  /**
   * Direct children *not* positively identified as the daemon's own service processes, or
   * null when the host could not enumerate them. This — not `childCount` — is what says
   * whether the relay holds anything; see relay-daemon-service-children.ts.
   */
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

// Why ES5 syntax: nodePath may be a host-resolved system node, not the bundled one.
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

export class RelayProbeCleanupUnconfirmedError extends Error {
  readonly name = 'RelayProbeCleanupUnconfirmedError'
  constructor() {
    super('Remote relay probe cleanup is unverifiable; refusing to race a replacement launch')
  }
}

/**
 * A POSIX probe that reports only what the host actually observed. Every field has an
 * explicit "could not tell" value; nothing is inferred from a missing tool.
 */
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
    // The inode is held by a running process that is not accepting — wedged, not gone.
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

/** `unknown`, a missing field, and anything unparseable are all "could not tell" — never 0. */
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
  // Windows relays are named pipes: there is no inode to unlink and no `lsof`, so the
  // orphan-by-unlink mechanism this probe defends against cannot occur there.
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
    // An exec whose channel never confirmed close may still be running remotely; the caller
    // must not race a detached launch against it.
    if (
      err instanceof RelayProbeCleanupUnconfirmedError ||
      isUnconfirmedSshCommandTermination(err)
    ) {
      throw err
    }
    // Any other unanswered probe observes nothing. It is never evidence of death.
    return unverifiableEndpoint(sockPath)
  }
}

/**
 * A live relay that provably holds nothing: identity confirmed against its argv, exactly one
 * holder, and no child the host could not account for as one of the daemon's own service
 * processes. Reaping it destroys no user work. Anything less is retained — killing the wrong
 * pid on someone's remote host is the worst outcome available here.
 *
 * Why not `childCount === 0`: the daemon's AI Vault sidecar never exits once spawned, so that
 * gate was unreachable for any relay that had ever served a vault request (#13614).
 */
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
