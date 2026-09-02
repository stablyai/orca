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
 *   invisible to this probe by construction — that is what the superseded sweep is for.
 * - a probe that could not run, a host without `lsof`, or a connect that failed for any other
 *   reason is `unverifiable`. It never authorizes unlinking, rebinding over, or signalling.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export type RelayEndpointVerdict = 'live' | 'unverifiable' | 'exited'

export type RelayEndpointEvidence =
  | 'accepted-connection'
  | 'handshake-refusal'
  | 'holder-process'
  | 'no-holder'
  | 'inconclusive'

export type RelayEndpointHolder = {
  pid: number
  /** The holder's argv names relay.js AND this exact socket path. */
  matchesRelayArgv: boolean
  /** Direct children, or null when `pgrep` could not answer. Never guessed. */
  childCount: number | null
}

export type RelayEndpointIncumbent = {
  sockPath: string
  verdict: RelayEndpointVerdict
  evidence: RelayEndpointEvidence
  socketPresent: boolean
  /** Pids proven to hold this exact socket. Empty when the host could not enumerate them. */
  holders: RelayEndpointHolder[]
  /** False when no enumeration tool was available — an empty `holders` then proves nothing. */
  holdersEnumerable: boolean
}

const PROBE_BEGIN = 'ORCA-INCUMBENT-BEGIN'
const PROBE_END = 'ORCA-INCUMBENT-END'
const CONNECT_PROBE_TIMEOUT_MS = 1000

// Why ES5 syntax: nodePath may be a host-resolved system node, not the bundled one.
const CONNECT_PROBE_JS = [
  'var s=require("net").connect(process.argv[1]);',
  'var done=false;',
  'function say(v){if(done)return;done=true;try{s.destroy()}catch(e){};',
  'process.stdout.write(v);process.exit(0)}',
  's.on("connect",function(){say("accepted")});',
  's.on("error",function(e){',
  'say(e.code==="ECONNREFUSED"?"refused":e.code==="ENOENT"?"absent":"unknown")});',
  `setTimeout(function(){say("unknown")},${CONNECT_PROBE_TIMEOUT_MS})`
].join('')

/**
 * A POSIX probe that reports only what the host actually observed. Every field has an
 * explicit "could not tell" value; nothing is inferred from a missing tool.
 */
export function relayEndpointIncumbentProbeCommand(nodePath: string, sockPath: string): string {
  const sock = shellEscape(sockPath)
  const node = shellEscape(nodePath)
  return [
    `sock=${sock}`,
    `node=${node}`,
    `printf '%s\\n' ${shellEscape(PROBE_BEGIN)}`,
    'if [ -S "$sock" ]; then',
    "  printf 'PRESENT=yes\\n'",
    `  listen=$("$node" -e ${shellEscape(CONNECT_PROBE_JS)} "$sock" 2>/dev/null) || listen=unknown`,
    '  [ -n "$listen" ] || listen=unknown',
    'else',
    "  printf 'PRESENT=no\\n'",
    '  listen=absent',
    'fi',
    'printf \'LISTEN=%s\\n\' "$listen"',
    'if command -v lsof >/dev/null 2>&1; then',
    "  printf 'HOLDERS_SOURCE=lsof\\n'",
    // Why -a: lsof ORs its selectors, so without it every unix-socket holder on the box
    // would be reported as holding this path (#8762).
    '  for pid in $(lsof -t -a -U "$sock" 2>/dev/null); do',
    '    args=$(ps -o args= -p "$pid" 2>/dev/null | tr "\\n" " ")',
    '    match=no',
    '    case "$args" in *relay.js*"$sock"*) match=yes ;; esac',
    '    kids=unknown',
    '    if command -v pgrep >/dev/null 2>&1; then',
    '      kids=$(pgrep -P "$pid" 2>/dev/null | grep -c .)',
    '    fi',
    '    printf \'HOLDER=%s %s %s\\n\' "$pid" "$match" "$kids"',
    '  done',
    'else',
    "  printf 'HOLDERS_SOURCE=unavailable\\n'",
    'fi',
    `printf '%s\\n' ${shellEscape(PROBE_END)}`
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
  if (holdersEnumerable && (listen === 'refused' || listen === 'absent')) {
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

function parseHolder(value: string): RelayEndpointHolder | null {
  const [rawPid, rawMatch, rawKids] = value.split(/\s+/)
  const pid = Number.parseInt(rawPid ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  const childCount = Number.parseInt(rawKids ?? '', 10)
  return {
    pid,
    matchesRelayArgv: rawMatch === 'yes',
    childCount: Number.isInteger(childCount) && childCount >= 0 ? childCount : null
  }
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
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    // Any other unanswered probe observes nothing. It is never evidence of death.
    return unverifiableEndpoint(sockPath)
  }
}

/**
 * A relay that told us its version over the wire is `live` by positive host evidence, even on
 * a host where nothing can enumerate socket holders.
 */
export function withHandshakeRefusalEvidence(
  incumbent: RelayEndpointIncumbent
): RelayEndpointIncumbent {
  if (incumbent.verdict === 'live') {
    return incumbent
  }
  return { ...incumbent, verdict: 'live', evidence: 'handshake-refusal' }
}

/**
 * May a fresh relay be launched onto this path?
 *
 * Only `live` forbids it. `unverifiable` is permitted because the *daemon* — not the client —
 * performs the takeover: `RelaySocketOwnership.listen` re-probes on EADDRINUSE, refuses to
 * steal a path that accepts connections, and only unlinks an inode whose identity is
 * unchanged. That check is atomic with the bind, which a client-side `rm -f` can never be.
 */
export function mayLaunchOverRelayEndpoint(incumbent: RelayEndpointIncumbent): boolean {
  return incumbent.verdict !== 'live'
}

/**
 * A live relay that provably holds nothing: identity confirmed against its argv, exactly one
 * holder, and zero children. Reaping it destroys no user work. Anything less is retained —
 * killing the wrong pid on someone's remote host is the worst outcome available here.
 */
export function isReapableRelayHusk(incumbent: RelayEndpointIncumbent): boolean {
  if (incumbent.verdict !== 'live' || !incumbent.holdersEnumerable) {
    return false
  }
  if (incumbent.holders.length !== 1) {
    return false
  }
  const [holder] = incumbent.holders
  return holder.matchesRelayArgv && holder.childCount === 0
}

export function describeRelayEndpointIncumbent(incumbent: RelayEndpointIncumbent): string {
  const holders = incumbent.holders
    .map((holder) => `${holder.pid}(children=${holder.childCount ?? 'unknown'})`)
    .join(',')
  return (
    `${incumbent.sockPath} verdict=${incumbent.verdict} evidence=${incumbent.evidence} ` +
    `holders=${incumbent.holdersEnumerable ? holders || 'none' : 'unenumerable'}`
  )
}

/**
 * Thrown instead of orphaning: a live relay owns the endpoint and refused us, so the path is
 * not ours to rebind. Terminal for this attempt — the user resolves it with Reset Relay,
 * which signals the incumbent deliberately and with consent.
 */
export class RelayEndpointHeldError extends Error {
  readonly name = 'RelayEndpointHeldError'
  constructor(readonly incumbent: RelayEndpointIncumbent) {
    super(
      `A live relay still owns ${incumbent.sockPath} and refused this connection ` +
        `(${describeRelayEndpointIncumbent(incumbent)}). Orca will not replace it, because ` +
        'unlinking its socket would strand its terminals. Use Reset Relay for this host to ' +
        'stop it, then reconnect.'
    )
  }
}

export function isRelayEndpointHeldError(err: unknown): err is RelayEndpointHeldError {
  return err instanceof RelayEndpointHeldError
}
