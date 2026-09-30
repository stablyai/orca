import { createHash } from 'node:crypto'
import { realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { relayLogLine } from './relay-diagnostic-log'

export type AgentSocketRejectReason =
  | 'not-absolute'
  | 'loop'
  | 'missing'
  | 'not-socket'
  | 'uid-mismatch'
  | 'link-failed'

export type RelayAgentSocketBindingSnapshot = {
  bound: boolean
  boundClientIsOwner: boolean
  bridgeRecords: number
  lastChangeAt: number | null
  lastRejectReason: AgentSocketRejectReason | null
}

type BridgeRecord = { clientId: number; seq: number; socket: string | null }

type BindingOptions = {
  linkPath: string
  /** Whether a client currently holds the PTY session owner grant. */
  isSessionOwner: (clientId: number) => boolean
  env?: NodeJS.ProcessEnv
  uid?: number
}

/**
 * Same length as the relay socket name (`relay-<16 hex>.sock`), so the relay socket's own
 * sun_path check already covers it: connect() needs the link path to fit, not its target.
 */
export function agentLinkPathForRelaySocket(sockPath: string): string {
  const hash = createHash('sha256').update(basename(sockPath)).digest('hex').slice(0, 16)
  return join(dirname(sockPath), `agent-${hash}.sock`)
}

/**
 * Gives every process the relay spawns a stable SSH_AUTH_SOCK that follows the live connection.
 *
 * The detached relay outlives the SSH connection that launched it, so its inherited SSH_AUTH_SOCK
 * dies with that connection (at once, under system ssh without ControlMaster). Each `--connect`
 * bridge reports its own session's socket; the binding points one symlink at the socket of the
 * PTY session owner (else the newest bridge) and exports the link path through process.env,
 * which PTY, git and agent-exec spawns read at spawn time. A shell started while bound keeps
 * working across reconnects because only the link target moves.
 *
 * With no bound socket the link is removed and SSH_AUTH_SOCK is unset — what a plain
 * `ssh host` sees without forwarding — so a newer connection without forwarding never
 * borrows an older connection's agent, and rc files that start an agent when the variable is
 * empty still do.
 */
export class RelayAgentSocketBinding {
  private readonly records = new Map<number, BridgeRecord>()
  private readonly env: NodeJS.ProcessEnv
  private readonly uid: number | undefined
  private seq = 0
  private tempSeq = 0
  private bound: { clientId: number; socket: string } | null = null
  private lastChangeAt: number | null = null
  private lastRejectReason: AgentSocketRejectReason | null = null

  constructor(private readonly options: BindingOptions) {
    this.env = options.env ?? process.env
    this.uid = options.uid ?? process.getuid?.()
  }

  /** Drops the launch exec's SSH_AUTH_SOCK before any child can inherit it. */
  start(): void {
    this.removeLink()
    delete this.env.SSH_AUTH_SOCK
  }

  /** Must run before the bridge's first request is dispatched, so its spawns see the binding. */
  registerBridge(clientId: number, agentSocket: string | undefined): void {
    const socket = agentSocket === undefined ? null : this.validate(agentSocket)
    this.records.set(clientId, { clientId, seq: ++this.seq, socket })
    this.apply()
  }

  forgetClient(clientId: number): void {
    if (this.records.delete(clientId)) {
      this.apply()
    }
  }

  sessionOwnerChanged(): void {
    this.apply()
  }

  dispose(): void {
    this.records.clear()
    this.bound = null
    this.removeLink()
  }

  snapshot(): RelayAgentSocketBindingSnapshot {
    return {
      bound: this.bound !== null,
      boundClientIsOwner: this.bound ? this.options.isSessionOwner(this.bound.clientId) : false,
      bridgeRecords: this.records.size,
      lastChangeAt: this.lastChangeAt,
      lastRejectReason: this.lastRejectReason
    }
  }

  private validate(agentSocket: string): string | null {
    const reject = (reason: AgentSocketRejectReason): null => {
      this.lastRejectReason = reason
      relayLogLine(`[relay] Ignoring bridge agent socket: ${reason}`)
      return null
    }
    if (!isAbsolute(agentSocket)) {
      return reject('not-absolute')
    }
    if (agentSocket === this.options.linkPath) {
      return reject('loop')
    }
    let real: string
    try {
      // Why bind to the resolved path: a chain through our own link would otherwise loop.
      real = realpathSync(agentSocket)
    } catch {
      return reject('missing')
    }
    try {
      const st = statSync(real)
      if (!st.isSocket()) {
        return reject('not-socket')
      }
      if (this.uid !== undefined && st.uid !== this.uid) {
        return reject('uid-mismatch')
      }
    } catch {
      return reject('missing')
    }
    return real
  }

  private select(): BridgeRecord | null {
    let newest: BridgeRecord | null = null
    let newestOwner: BridgeRecord | null = null
    for (const record of this.records.values()) {
      if (!newest || record.seq > newest.seq) {
        newest = record
      }
      if (
        this.options.isSessionOwner(record.clientId) &&
        (!newestOwner || record.seq > newestOwner.seq)
      ) {
        newestOwner = record
      }
    }
    return newestOwner ?? newest
  }

  private apply(): void {
    const selected = this.select()
    if (!selected || selected.socket === null) {
      if (this.bound !== null) {
        this.unbind()
        relayLogLine(`[relay] Agent socket unbound (bridges=${this.records.size})`)
      }
      return
    }
    const { clientId, socket } = selected
    if (this.bound?.socket === socket) {
      this.bound = { clientId, socket }
      return
    }
    try {
      this.pointLinkAt(socket)
    } catch (error) {
      this.lastRejectReason = 'link-failed'
      relayLogLine(
        `[relay] Could not update agent socket link: ${error instanceof Error ? error.message : String(error)}`
      )
      this.unbind()
      return
    }
    this.bound = { clientId, socket }
    this.env.SSH_AUTH_SOCK = this.options.linkPath
    this.lastChangeAt = Date.now()
    relayLogLine(`[relay] Agent socket bound (bridges=${this.records.size})`)
  }

  private unbind(): void {
    this.bound = null
    this.removeLink()
    delete this.env.SSH_AUTH_SOCK
    this.lastChangeAt = Date.now()
  }

  // Why rename: an in-place replace would leave a window where the link is missing.
  private pointLinkAt(target: string): void {
    const temp = `${this.options.linkPath}.${process.pid}.${++this.tempSeq}.tmp`
    symlinkSync(target, temp)
    try {
      renameSync(temp, this.options.linkPath)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* best effort */
      }
      throw error
    }
  }

  private removeLink(): void {
    try {
      unlinkSync(this.options.linkPath)
    } catch {
      /* already absent */
    }
  }
}
